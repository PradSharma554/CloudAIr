// A polite, checkpointed BFS crawler that runs inside the web service (the
// free tier has no workers). After every page it persists progress, so a
// spin-down mid-crawl loses at most one page; a reaper resumes stalled crawls
// from their checkpoints on boot.
import { setTimeout as sleep } from "node:timers/promises";
import robotsParserImport from "robots-parser";
import type { CrawlStore } from "../store/crawls.js";
import type { PageStore } from "../store/pages.js";
import type { SiteStore } from "../store/sites.js";
import { maxPages, type Crawl, type Site } from "../store/types.js";
import { extract } from "./extract.js";
import { USER_AGENT } from "./shared.js";
import { fetchSitemap } from "./sitemap.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const CRAWL_TIMEOUT_MS = 20 * 60 * 1000;
const POLITENESS_MS = 1000;
const SKIP_EXTENSIONS = [
  ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".zip", ".gz",
  ".mp4", ".mp3", ".css", ".js", ".ico", ".xml", ".json", ".woff", ".woff2",
];

// robots-parser is CJS with a broken ESM type declaration; type it ourselves.
interface RobotsChecker {
  isDisallowed(url: string, ua?: string): boolean | undefined;
}
const robotsParser = robotsParserImport as unknown as (url: string, contents: string) => RobotsChecker;

// robots-parser is origin-strict: it answers undefined/blocked for URLs on a
// different host than its robots.txt (e.g. www vs apex after a redirect). We
// only care about PATH rules, so checks rewrite the URL onto the robots
// origin first.
interface Robots {
  checker: RobotsChecker;
  origin: string;
}

function robotsBlocked(robots: Robots | null, pageUrl: string): boolean {
  if (!robots) return false;
  try {
    const u = new URL(pageUrl);
    const onRobotsOrigin = new URL(u.pathname + u.search, robots.origin).toString();
    return robots.checker.isDisallowed(onRobotsOrigin, "CloudAIrBot") === true;
  } catch {
    return false;
  }
}

/** Runs after a successful crawl (llms.txt generation is wired in by index.ts). */
export type PostCrawl = (site: Site) => Promise<void>;

export class Crawler {
  /** siteId → crawl loop running in this process */
  private active = new Set<string>();

  constructor(
    private sites: SiteStore,
    private pages: PageStore,
    private crawls: CrawlStore,
    private postCrawl: PostCrawl | null
  ) {}

  /** Begins a crawl for the site unless one is already running. */
  async start(site: Site): Promise<Crawl> {
    if (await this.crawls.running(site.id)) {
      throw new Error("crawl already running");
    }
    const crawl = await this.crawls.create(site.id, maxPages(site));
    this.launch(site, crawl);
    return crawl;
  }

  /**
   * Reaps crawls whose process died (restart) and resumes them from their
   * checkpoints. Called on boot and from /internal/recrawl.
   */
  async resumeStalled(): Promise<void> {
    const stalled = await this.crawls.reapStalled();
    for (const crawl of stalled) {
      let site: Site;
      try {
        site = await this.sites.byId(crawl.siteId);
      } catch (err) {
        console.error(`cannot resume crawl ${crawl.id}: site lookup failed`, err);
        continue;
      }
      await this.crawls.resume(crawl.id);
      console.log(`resuming stalled crawl for ${site.domain} (${crawl.pagesCrawled} pages done)`);
      this.launch(site, crawl);
    }
  }

  private launch(site: Site, crawl: Crawl): void {
    if (this.active.has(site.id)) return;
    this.active.add(site.id);
    void (async () => {
      try {
        await this.run(site, crawl);
        await this.crawls.finish(crawl.id, "completed", "");
        console.log(`crawl completed: ${site.domain}`);
      } catch (err) {
        console.error(`crawl failed: ${site.domain}:`, (err as Error).message);
        await this.crawls.finish(crawl.id, "failed", (err as Error).message).catch(() => {});
      } finally {
        this.active.delete(site.id);
      }
    })();
  }

  private async run(site: Site, crawl: Crawl): Promise<void> {
    // Stale-page cleanup must key off the crawl's ORIGINAL start, not the
    // resume time — otherwise a resumed crawl deletes its own pre-kill pages.
    const started = crawl.startedAt ?? new Date();
    const deadline = Date.now() + CRAWL_TIMEOUT_MS;
    const base = `https://${site.domain}`;

    const robots = await this.fetchRobots(base);

    const visited = new Set<string>(crawl.checkpoint?.visited ?? []);
    let frontier: string[] = crawl.checkpoint?.frontier ?? [];
    let pagesDone = crawl.pagesCrawled;

    if (frontier.length === 0 && pagesDone === 0) {
      const seeds = await fetchSitemap(base);
      for (const s of seeds) {
        const u = normalize(site, s);
        if (u && !visited.has(u)) frontier.push(u);
      }
      const home = normalize(site, `${base}/`);
      if (home) frontier.unshift(home);
    }

    while (frontier.length > 0 && pagesDone < crawl.maxPages) {
      if (Date.now() > deadline) {
        // Timeout: checkpoint is already persisted per page; the reaper will
        // resume this crawl on a later boot.
        throw new Error("crawl timeout");
      }
      await sleep(POLITENESS_MS);

      const pageUrl = frontier.shift()!;
      if (visited.has(pageUrl)) continue;
      visited.add(pageUrl);

      if (robotsBlocked(robots, pageUrl)) continue;

      let links: string[] = [];
      try {
        links = await this.fetchPage(site, pageUrl);
        pagesDone++;
      } catch (err) {
        console.warn(`crawl skip ${pageUrl}: ${(err as Error).message}`);
      }
      for (const link of links) {
        const u = normalize(site, link);
        if (u && !visited.has(u)) frontier.push(u);
      }
      if (frontier.length > 500) frontier = frontier.slice(0, 500);

      await this.crawls.checkpoint(crawl.id, pagesDone, {
        frontier,
        visited: [...visited].sort(),
      });
    }

    if (pagesDone === 0) {
      throw new Error(`no pages could be crawled from ${base}`);
    }

    // Remove pages that disappeared since the previous crawl — but never let
    // a degenerate crawl (network flake, robots misread) wipe a previously
    // healthy index: skip cleanup when this crawl saw under half the stored
    // pages.
    const stored = await this.pages.list(site.id).catch(() => []);
    if (pagesDone >= stored.length / 2) {
      await this.pages.deleteStale(site.id, started).catch(() => {});
    } else {
      console.warn(
        `skipping stale-page cleanup for ${site.domain}: crawl saw ${pagesDone} pages but ${stored.length} are stored`
      );
    }

    if (this.postCrawl) {
      // Summarization can take minutes at 8 RPM; keep the heartbeat alive so
      // the reaper doesn't mark this crawl stalled.
      const heartbeat = setInterval(() => {
        void this.crawls.checkpoint(crawl.id, pagesDone, { frontier: [], visited: [] });
      }, 30_000);
      try {
        await this.postCrawl(site);
      } finally {
        clearInterval(heartbeat);
      }
    }
  }

  /** Downloads, extracts, and stores one page, returning its links. */
  private async fetchPage(site: Site, pageUrl: string): Promise<string[]> {
    const resp = await fetch(pageUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const contentType = resp.headers.get("content-type") ?? "";
    const mime = contentType.split(";")[0].trim();
    if (mime && mime !== "text/html" && mime !== "application/xhtml+xml") {
      throw new Error(`skipping content-type ${mime}`);
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    const html = buf.subarray(0, MAX_BODY_BYTES).toString("utf8");

    const finalUrl = new URL(resp.url || pageUrl);
    if (!sameSite(site, finalUrl.hostname)) {
      throw new Error(`redirected off-site to ${finalUrl}`);
    }

    const ex = extract(html, finalUrl.toString());
    if (!ex.markdown) return ex.links.length ? ex.links : Promise.reject(new Error("no content"));

    await this.pages.upsert({
      siteId: site.id,
      url: finalUrl.toString(),
      path: finalUrl.pathname || "/",
      title: ex.title,
      metaDesc: ex.metaDesc,
      contentHash: ex.hash,
      markdown: ex.markdown,
    });
    return ex.links;
  }

  private async fetchRobots(base: string): Promise<Robots | null> {
    try {
      const resp = await fetch(`${base}/robots.txt`, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) return null;
      // Use the FINAL (post-redirect) URL as the parser origin so path checks
      // line up with the host the site actually serves from.
      const finalUrl = resp.url || `${base}/robots.txt`;
      return {
        checker: robotsParser(finalUrl, await resp.text()),
        origin: new URL(finalUrl).origin,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Canonicalizes a URL; returns "" if it should not be crawled (off-site,
 * non-http, binary-looking, tracking junk).
 */
export function normalize(site: Site, raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  const host = u.hostname.toLowerCase();
  if (!sameSite(site, host)) return "";

  u.hash = "";
  u.username = "";
  u.password = "";
  u.hostname = host;
  for (const key of [...u.searchParams.keys()]) {
    if (key.startsWith("utm_") || key === "ref" || key === "fbclid" || key === "gclid") {
      u.searchParams.delete(key);
    }
  }
  if (u.pathname.endsWith("/") && u.pathname !== "/") {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }
  if (!u.pathname) u.pathname = "/";

  const lower = u.pathname.toLowerCase();
  if (SKIP_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "";
  return u.toString();
}

/** Allows the registered domain, its www variant, and subdomains. */
export function sameSite(site: Site, host: string): boolean {
  const h = host.toLowerCase();
  return h === site.domain || h === `www.${site.domain}` || h.endsWith(`.${site.domain}`);
}
