import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import { LRUCache } from "lru-cache";
import type { AgentClassifier } from "../agents.js";
import type { Limiter, RuleSource } from "../ratelimit.js";
import type { Recorder } from "../recorder.js";
import type { SiteStore } from "../store/sites.js";
import { getAgent, getSite, getUserId, setAgent, setSite, setUserId } from "./context.js";
import type { SiteCache } from "./resolver.js";

/** Express 4 does not catch async middleware rejections; this wrapper does. */
function asyncMw(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Resolves the site for agent-facing routes and 404s unverified sites. */
export function siteCtx(cache: SiteCache): RequestHandler {
  return asyncMw(async (req, res, next) => {
    const site = await cache.bySlug(req.params.slug);
    if (!site) {
      res.status(404).json({ error: "site not found" });
      return;
    }
    if (!site.verifiedAt) {
      res.status(404).json({ error: "site not verified" });
      return;
    }
    setSite(res, site);
    next();
  });
}

/** Classifies the visitor and stores the result in res.locals. */
export function agentIdentify(classifier: AgentClassifier): RequestHandler {
  return (req, res, next) => {
    let info = classifier.classify(req.header("user-agent") ?? "", req.header("accept-language") ?? "");
    // Only agents speak MCP; upgrade unidentified MCP traffic to declared.
    if (req.path.endsWith("/mcp") && info.class !== "declared-agent" && info.class !== "verified-agent") {
      info = { class: "declared-agent", name: info.name || mcpClientName(req), operator: info.operator };
    }
    setAgent(res, info);
    next();
  };
}

/** Pulls clientInfo.name out of an MCP initialize body (already JSON-parsed). */
function mcpClientName(req: Request): string {
  const body = req.body as { method?: string; params?: { clientInfo?: { name?: string } } } | undefined;
  if (body?.method === "initialize") {
    return body.params?.clientInfo?.name ?? "";
  }
  return "";
}

/**
 * Records one analytics event per agent-facing request. Registered BEFORE the
 * rate limiter so blocked (429) requests are visible in the dashboard too.
 */
export function record(recorder: Recorder): RequestHandler {
  return (req, res, next) => {
    const start = Date.now();
    const { kind, toolName } = classifyRequest(req);
    res.on("finish", () => {
      const site = getSite(res);
      if (!site) return;
      const agent = getAgent(res);
      recorder.record({
        siteId: site.id,
        ts: new Date(),
        agentClass: agent.class,
        agentName: agent.name,
        kind,
        toolName,
        path: req.originalUrl.split("?")[0],
        statusCode: res.statusCode,
        latencyMs: Date.now() - start,
        userAgent: req.header("user-agent") ?? "",
      });
    });
    next();
  };
}

function classifyRequest(req: Request): { kind: "llms_txt" | "mcp_tool" | "page"; toolName: string } {
  if (req.path.endsWith("/llms.txt") || req.path.endsWith("/llms-full.txt")) {
    return { kind: "llms_txt", toolName: "" };
  }
  if (req.path.endsWith("/mcp")) {
    const body = req.body as { method?: string; params?: { name?: string } } | undefined;
    const toolName =
      body?.method === "tools/call" && body.params?.name ? body.params.name : (body?.method ?? "");
    return { kind: "mcp_tool", toolName };
  }
  return { kind: "page", toolName: "" };
}

/** Enforces per-(site, agent) token buckets with per-site rules. */
export function rateLimit(limiter: Limiter, rules: RuleSource): RequestHandler {
  return asyncMw(async (req, res, next) => {
    const site = getSite(res);
    const agent = getAgent(res);
    const subject = agent.name || agent.class;
    const [rpm, burst] = await rules.resolve(site.id, agent.name, agent.class);
    const result = limiter.allow(`${site.id}|${subject}`, rpm, burst);
    if (result.ok) {
      next();
      return;
    }
    res.set("Retry-After", String(result.retryAfterSeconds));
    if (req.path.endsWith("/mcp")) {
      res.status(429).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: `rate limited, retry after ${result.retryAfterSeconds}s` },
      });
      return;
    }
    res.status(429).json({ error: "rate limited", retry_after_seconds: result.retryAfterSeconds });
  });
}

const userCache = new LRUCache<string, string>({ max: 2048, ttl: 5 * 60_000 });

/**
 * Verifies the HS256 JWT minted by the dashboard proxy and puts the user ID
 * in res.locals, lazily creating the users row. (Auth.js session cookies are
 * encrypted JWEs the API never sees — the Next.js proxy is the bridge.)
 */
export function requireAuth(secret: string, sites: SiteStore): RequestHandler {
  return asyncMw(async (req, res, next) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      res.status(401).json({ error: "missing bearer token" });
      return;
    }
    let claims: jwt.JwtPayload;
    try {
      claims = jwt.verify(token, secret, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    } catch {
      res.status(401).json({ error: "invalid token" });
      return;
    }
    const sub = claims.sub ?? "";
    const idx = sub.indexOf(":");
    const provider = idx > 0 ? sub.slice(0, idx) : "";
    const providerId = idx > 0 ? sub.slice(idx + 1) : "";
    if (!provider || !providerId) {
      res.status(401).json({ error: "invalid subject" });
      return;
    }
    const cached = userCache.get(sub);
    if (cached) {
      setUserId(res, cached);
      next();
      return;
    }
    const email = (claims.email as string) ?? "";
    if (!email) {
      res.status(401).json({ error: "email claim required" });
      return;
    }
    const user = await sites.upsertUser(provider, providerId, email, (claims.name as string) ?? "");
    userCache.set(sub, user.id);
    setUserId(res, user.id);
    next();
  });
}

/** Loads the site by slug and enforces ownership (404 either way so slugs can't be probed). */
export function ownedSiteCtx(sites: SiteStore): RequestHandler {
  return asyncMw(async (req, res, next) => {
    try {
      const site = await sites.bySlug(req.params.slug);
      if (site.userId !== getUserId(res)) throw new Error("not owner");
      setSite(res, site);
      next();
    } catch {
      res.status(404).json({ error: "site not found" });
    }
  });
}
