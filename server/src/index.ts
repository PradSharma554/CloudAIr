// CloudAIr server entrypoint: agent-facing site endpoints (llms.txt,
// markdown mirrors, MCP), the dashboard API, and in-process crawls — one
// process sized for a single free-tier instance.
import "./polyfill.js";
import { AgentClassifier } from "./agents.js";
import { loadConfig } from "./config.js";
import { Crawler } from "./crawler/crawler.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { newVerificationToken, slugify } from "./domains.js";
import { buildApp } from "./http/app.js";
import { LlmClient } from "./llm.js";
import { LlmsTxtGenerator } from "./llmstxt.js";
import { McpManager } from "./mcp.js";
import { MemoryLimiter, RuleSource } from "./ratelimit.js";
import { Recorder } from "./recorder.js";
import { AnalyticsStore } from "./store/analytics.js";
import { CrawlStore } from "./store/crawls.js";
import { PageStore } from "./store/pages.js";
import { SiteStore } from "./store/sites.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl);

  await migrate(pool);
  if (process.argv.includes("--migrate-only")) {
    console.log("migrations applied");
    await pool.end();
    return;
  }

  const sites = new SiteStore(pool);
  const pages = new PageStore(pool);
  const crawls = new CrawlStore(pool);
  const analytics = new AnalyticsStore(pool);

  if (process.argv.includes("--seed")) {
    const user = await sites.upsertUser("dev", "local", "dev@localhost", "Dev User");
    try {
      const site = await sites.create(user.id, "example.com", slugify("example.com"), newVerificationToken());
      console.log(`seeded: ${user.email} / ${site.domain} (${site.slug})`);
    } catch {
      console.log("seed site already exists");
    }
    await pool.end();
    return;
  }

  const llm = new LlmClient(cfg.geminiApiKey, cfg.geminiModel);
  if (!llm.enabled()) {
    console.warn("GEMINI_API_KEY not set — llms.txt will use the non-LLM fallback");
  }

  const generator = new LlmsTxtGenerator(sites, pages, llm, cfg.publicBaseUrl);
  const crawler = new Crawler(sites, pages, crawls, (site) => generator.generate(site));
  const recorder = new Recorder(analytics);

  const app = buildApp({
    cfg,
    pool,
    sites,
    pages,
    crawls,
    analytics,
    crawler,
    llm,
    mcp: new McpManager(pages, cfg.publicBaseUrl),
    classifier: new AgentClassifier(),
    limiter: new MemoryLimiter(),
    rules: new RuleSource((siteId) => analytics.rateLimitRuleMap(siteId)),
    recorder,
  });

  // Resume crawls orphaned by the last spin-down/deploy.
  await crawler.resumeStalled().catch((err) => console.error("resume stalled crawls:", err));

  const server = app.listen(cfg.port, () => {
    console.log(`listening on :${cfg.port} (public base: ${cfg.publicBaseUrl})`);
  });

  // Render sends SIGTERM before spin-down: drain HTTP, flush analytics.
  const shutdown = (signal: string) => {
    console.log(`shutting down (${signal})`);
    server.close(async () => {
      await recorder.close();
      await pool.end();
      process.exit(0);
    });
    // Hard exit if draining hangs.
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
