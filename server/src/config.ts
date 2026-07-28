// Environment configuration for the CloudAIr server.

export interface Config {
  /** Port the HTTP server listens on. Render injects PORT. */
  port: number;
  /** Postgres connection string (Neon in prod). */
  databaseUrl: string;
  /** Shared with the Next.js proxy that mints dashboard JWTs. */
  apiJwtSecret: string;
  /** Guards /internal/* endpoints (GitHub Actions cron). */
  internalToken: string;
  /** Enables LLM summaries; empty engages the non-LLM fallback. */
  geminiApiKey: string;
  /** Model used for summaries. */
  geminiModel: string;
  /** Externally reachable base URL, used in llms.txt and MCP URLs. */
  publicBaseUrl: string;
  /** When set (e.g. ".cloudair.dev"), enables Host-header site resolution. */
  hostSuffix: string;
}

export function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return {
    port: Number(process.env.PORT) || 8080,
    databaseUrl,
    apiJwtSecret: process.env.API_JWT_SECRET ?? "",
    internalToken: process.env.INTERNAL_TOKEN ?? "",
    geminiApiKey: process.env.GEMINI_API_KEY ?? "",
    geminiModel: process.env.GEMINI_MODEL || "gemini-3.1-flash-lite",
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || "http://localhost:8080").replace(/\/$/, ""),
    hostSuffix: process.env.HOST_SUFFIX ?? "",
  };
}
