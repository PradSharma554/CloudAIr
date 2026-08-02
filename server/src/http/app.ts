// Wires the CloudAIr HTTP surface: agent-facing site endpoints (llms.txt,
// page mirrors, MCP), the JWT-authenticated dashboard API, and internal cron
// endpoints.
//
// Agent-facing middleware chain:
//   siteCtx → agentIdentify → record → rateLimit → paywall → handler
import { timingSafeEqual } from "node:crypto";
import express, { Router, type Express } from "express";
import type pg from "pg";
import type { AgentClassifier } from "../agents.js";
import type { Config } from "../config.js";
import type { Crawler } from "../crawler/crawler.js";
import { dbHealth, dbSizeBytes } from "../db/pool.js";
import { newVerificationToken, normalizeDomain, slugify } from "../domains.js";
import type { LlmClient } from "../llm.js";
import type { McpManager } from "../mcp.js";
import type { Limiter, RuleSource } from "../ratelimit.js";
import type { Recorder } from "../recorder.js";
import type { AnalyticsStore } from "../store/analytics.js";
import type { CrawlStore } from "../store/crawls.js";
import type { PageStore } from "../store/pages.js";
import type { SiteStore } from "../store/sites.js";
import { NotFoundError, type Crawl, type RateLimitRule, type Site, type SiteSettings } from "../store/types.js";
import { checkOwnership } from "../verify.js";
import { getSite, getUserId, wrap } from "./context.js";
import { agentIdentify, ownedSiteCtx, paywall, rateLimit, record, requireAuth, siteCtx } from "./middleware.js";
import { hostSlug, SiteCache } from "./resolver.js";

export interface Deps {
  cfg: Config;
  pool: pg.Pool;
  sites: SiteStore;
  pages: PageStore;
  crawls: CrawlStore;
  analytics: AnalyticsStore;
  crawler: Crawler;
  llm: LlmClient;
  mcp: McpManager;
  classifier: AgentClassifier;
  limiter: Limiter;
  rules: RuleSource;
  recorder: Recorder;
}

export function buildApp(d: Deps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb", type: ["application/json", "application/*+json"] }));

  const siteCache = new SiteCache(d.sites);

  // Canonicalizes Host-resolved requests (<slug>.cloudair.dev/mcp) onto the
  // path form (/sites/<slug>/mcp) so one router serves both modes.
  if (d.cfg.hostSuffix) {
    app.use((req, _res, next) => {
      const slug = hostSlug(req, d.cfg.hostSuffix);
      if (slug) req.url = `/sites/${slug}${req.url}`;
      next();
    });
  }

  // Liveness only — deliberately touches nothing. Render's health checks and
  // the keepalive cron hit this; on serverless Postgres (Neon), a health
  // check that queries the database wakes its compute and burns the free
  // tier's CU-hours around the clock. Deep checks live at /healthz.
  app.get("/ping", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/healthz", wrap(async (_req, res) => {
    const size = await dbSizeBytes(d.pool).catch(() => 0);
    res.json({
      status: "ok",
      db: await dbHealth(d.pool),
      db_size_bytes: size,
      gemini_enabled: d.llm.enabled(),
      gemini_calls: d.llm.calls(),
      analytics_drop_count: d.recorder.dropped(),
    });
  }));

  app.use("/sites/:slug", agentRouter(d, siteCache));
  app.use("/api/v1", apiRouter(d, siteCache));

  // Internal endpoint for the GitHub Actions cron: resume stalled crawls,
  // recrawl every verified site, roll up analytics, prune old events.
  app.post("/internal/recrawl", wrap(async (req, res) => {
    const token = req.header("x-internal-token") ?? "";
    if (!d.cfg.internalToken || !timingSafeEqualStr(token, d.cfg.internalToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    await d.crawler.resumeStalled().catch((err) => console.error("resume stalled failed:", err));
    const sites = await d.sites.listVerified();
    let started = 0;
    for (const site of sites) {
      try {
        await d.crawler.start(site);
        started++;
      } catch {
        /* already running — skip */
      }
    }
    let rollup = "ok";
    try {
      await d.analytics.rollupAndPrune();
    } catch (err) {
      rollup = (err as Error).message;
    }
    res.json({ sites: sites.length, crawls_started: started, rollup });
  }));

  // Uniform JSON error handler (must have 4 args for Express to use it).
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("unhandled error:", err);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  });

  return app;
}

/** Agent-facing endpoints, full middleware chain. */
function agentRouter(d: Deps, cache: SiteCache): Router {
  const r = Router({ mergeParams: true });
  r.use(siteCtx(cache));
  r.use(agentIdentify(d.classifier));
  r.use(record(d.recorder));
  r.use(rateLimit(d.limiter, d.rules));
  r.use(paywall());

  r.get("/llms.txt", (req, res) => {
    const site = getSite(res);
    if (!site.llmsTxt) {
      res.status(404).type("text/plain").send("llms.txt not generated yet — crawl in progress or not started");
      return;
    }
    res.set("Cache-Control", "public, max-age=3600").type("text/plain; charset=utf-8").send(site.llmsTxt);
  });

  // Streams every page's markdown so a 50-page site never sits in memory at once.
  r.get("/llms-full.txt", wrap(async (req, res) => {
    const site = getSite(res);
    res.set("Cache-Control", "public, max-age=3600").type("text/plain; charset=utf-8");
    res.write(`# ${site.domain}\n\n`);
    for await (const p of d.pages.iterateFull(site.id)) {
      res.write(`## ${p.title || p.path}\n\nURL: ${p.url}\n\n${p.markdown}\n\n---\n\n`);
    }
    res.end();
  }));

  r.get("/pages/*", wrap(async (req, res) => {
    const site = getSite(res);
    const path = "/" + String((req.params as Record<string, string>)[0] ?? "").replace(/^\/+/, "");
    try {
      const page = await d.pages.byPath(site.id, path);
      res
        .set("Cache-Control", "public, max-age=3600")
        .type("text/markdown; charset=utf-8")
        .send(`# ${page.title}\n\nSource: ${page.url}\n\n${page.markdown}\n`);
    } catch (err) {
      if (err instanceof NotFoundError) {
        res.status(404).type("text/plain").send(`page not found — see /sites/${site.slug}/llms.txt for the index`);
        return;
      }
      throw err;
    }
  }));

  r.all("/mcp", wrap(async (req, res) => {
    await d.mcp.handleRequest(getSite(res), req, res);
  }));

  return r;
}

/** Dashboard API (called by the Next.js proxy with a minted JWT). */
function apiRouter(d: Deps, cache: SiteCache): Router {
  const r = Router();
  r.use(requireAuth(d.cfg.apiJwtSecret, d.sites));

  r.post("/sites", wrap(async (req, res) => {
    const body = req.body as { domain?: string };
    let domain: string;
    try {
      domain = normalizeDomain(body.domain ?? "");
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    try {
      const site = await d.sites.create(getUserId(res), domain, slugify(domain), newVerificationToken());
      res.status(201).json(siteJson(d.cfg.publicBaseUrl, site, null));
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        res.status(409).json({ error: "domain already registered" });
        return;
      }
      throw err;
    }
  }));

  r.get("/sites", wrap(async (_req, res) => {
    const list = await d.sites.listByUser(getUserId(res));
    res.json({ sites: list.map((s) => siteJson(d.cfg.publicBaseUrl, s, null)) });
  }));

  const site = Router({ mergeParams: true });
  r.use("/sites/:slug", ownedSiteCtx(d.sites), site);

  site.get("/", wrap(async (_req, res) => {
    const s = getSite(res);
    const crawl = await d.crawls.latest(s.id).catch(() => null);
    res.json(siteJson(d.cfg.publicBaseUrl, s, crawl));
  }));

  site.delete("/", wrap(async (req, res) => {
    const s = getSite(res);
    await d.sites.delete(s.id);
    cache.invalidate(s.slug);
    res.json({ status: "deleted" });
  }));

  site.post("/verify", wrap(async (_req, res) => {
    const s = getSite(res);
    if (s.verifiedAt) {
      res.json({ verified: true, method: s.verificationMethod });
      return;
    }
    let method: string;
    try {
      method = await checkOwnership(s.domain, s.verificationToken);
    } catch (err) {
      res.json({ verified: false, detail: (err as Error).message });
      return;
    }
    await d.sites.markVerified(s.id, method);
    cache.invalidate(s.slug);
    // Kick off the first crawl right away — the wizard's next step.
    let crawlStarted = true;
    try {
      await d.crawler.start(s);
    } catch {
      crawlStarted = false;
    }
    res.json({ verified: true, method, crawl_started: crawlStarted });
  }));

  site.post("/crawls", wrap(async (_req, res) => {
    const s = getSite(res);
    if (!s.verifiedAt) {
      res.status(409).json({ error: "verify the site first" });
      return;
    }
    try {
      const crawl = await d.crawler.start(s);
      res.status(202).json(crawlJson(crawl));
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  }));

  site.get("/crawls/latest", wrap(async (_req, res) => {
    try {
      res.json({ crawl: crawlJson(await d.crawls.latest(getSite(res).id)) });
    } catch (err) {
      if (err instanceof NotFoundError) {
        res.json({ crawl: null });
        return;
      }
      throw err;
    }
  }));

  site.get("/llms-txt", (_req, res) => {
    const s = getSite(res);
    res.json({
      llms_txt: s.llmsTxt,
      generated_at: s.llmsTxtGeneratedAt,
      public_url: `${d.cfg.publicBaseUrl}/sites/${s.slug}/llms.txt`,
      mcp_url: `${d.cfg.publicBaseUrl}/sites/${s.slug}/mcp`,
    });
  });

  site.get("/rate-limits", wrap(async (_req, res) => {
    res.json({ rules: await d.analytics.listRateLimitRules(getSite(res).id) });
  }));

  site.put("/rate-limits", wrap(async (req, res) => {
    const s = getSite(res);
    const body = req.body as { rules?: RateLimitRule[] };
    const rules = body.rules ?? [];
    for (const rule of rules) {
      if (rule.subject_type !== "class" && rule.subject_type !== "agent") {
        res.status(400).json({ error: "subject_type must be 'class' or 'agent'" });
        return;
      }
      if (!rule.subject || !Number.isInteger(rule.rpm) || rule.rpm < 1 || rule.rpm > 100000) {
        res.status(400).json({ error: "subject required and rpm must be 1-100000" });
        return;
      }
    }
    await d.analytics.replaceRateLimitRules(s.id, rules);
    d.rules.invalidate(s.id);
    res.json({ status: "saved" });
  }));

  site.put("/settings", wrap(async (req, res) => {
    const s = getSite(res);
    const settings = req.body as SiteSettings;
    await d.sites.updateSettings(s.id, settings);
    cache.invalidate(s.slug);
    res.json({ status: "saved" });
  }));

  site.get("/analytics/timeseries", wrap(async (req, res) => {
    const { since, bucket } = rangeParams(req.query);
    res.json({ points: await d.analytics.timeseries(getSite(res).id, since, bucket) });
  }));

  site.get("/analytics/top", wrap(async (req, res) => {
    const { since } = rangeParams(req.query);
    const by = String(req.query.by ?? "agent");
    const limit = Number(req.query.limit) || 10;
    res.json({ entries: await d.analytics.top(getSite(res).id, by, since, limit) });
  }));

  return r;
}

function rangeParams(query: Record<string, unknown>): { since: Date; bucket: "hour" | "day" } {
  const now = Date.now();
  const range = String(query.range ?? "7d");
  const bucketParam = String(query.bucket ?? "");
  switch (range) {
    case "24h":
      return { since: new Date(now - 24 * 3600_000), bucket: bucketParam === "day" ? "day" : "hour" };
    case "30d":
      return { since: new Date(now - 30 * 86400_000), bucket: bucketParam === "hour" ? "hour" : "day" };
    default:
      return { since: new Date(now - 7 * 86400_000), bucket: bucketParam === "hour" ? "hour" : "day" };
  }
}

function crawlJson(c: Crawl): Record<string, unknown> {
  return {
    id: c.id,
    status: c.status,
    pages_crawled: c.pagesCrawled,
    max_pages: c.maxPages,
    error: c.error || undefined,
    started_at: c.startedAt,
    finished_at: c.finishedAt,
    created_at: c.createdAt,
  };
}

function siteJson(base: string, s: Site, crawl: Crawl | null): Record<string, unknown> {
  return {
    id: s.id,
    domain: s.domain,
    slug: s.slug,
    verified: s.verifiedAt !== null,
    verification_method: s.verificationMethod,
    verification_token: s.verificationToken,
    dns_record_host: `_cloudair.${s.domain}`,
    well_known_url: `https://${s.domain}/.well-known/cloudair-verify.txt`,
    llms_txt_url: `${base}/sites/${s.slug}/llms.txt`,
    llms_full_txt_url: `${base}/sites/${s.slug}/llms-full.txt`,
    mcp_url: `${base}/sites/${s.slug}/mcp`,
    llms_txt_generated: s.llmsTxtGeneratedAt !== null,
    settings: s.settings,
    created_at: s.createdAt,
    ...(crawl ? { latest_crawl: crawlJson(crawl) } : {}),
  };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
