export interface User {
  id: string;
  provider: string;
  providerId: string;
  email: string;
  name: string;
}

export interface SiteSettings {
  crawl: { max_pages?: number };
}

export interface Site {
  id: string;
  userId: string;
  domain: string;
  slug: string;
  verificationToken: string;
  verificationMethod: string;
  verifiedAt: Date | null;
  llmsTxt: string;
  llmsTxtGeneratedAt: Date | null;
  settings: SiteSettings;
  createdAt: Date;
}

export function maxPages(site: Site): number {
  const n = site.settings.crawl?.max_pages ?? 0;
  return n > 0 && n <= 50 ? n : 50;
}

export interface Page {
  id: string;
  siteId: string;
  url: string;
  path: string;
  title: string;
  metaDesc: string;
  contentHash: string;
  markdown: string;
  summary: string;
  summaryHash: string;
  fetchedAt: Date | null;
}

export interface SearchResult {
  path: string;
  url: string;
  title: string;
  summary: string;
  snippet: string;
}

export type CrawlStatus = "queued" | "running" | "completed" | "failed" | "stalled";

/** Persisted after every page so a spin-down loses at most one page of work. */
export interface Checkpoint {
  frontier: string[];
  visited: string[];
}

export interface Crawl {
  id: string;
  siteId: string;
  status: CrawlStatus;
  pagesCrawled: number;
  maxPages: number;
  checkpoint: Checkpoint | null;
  error: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export interface RateLimitRule {
  id?: string;
  subject_type: "class" | "agent";
  subject: string;
  rpm: number;
  burst: number;
}

export interface AgentRequestEvent {
  siteId: string;
  ts: Date;
  agentClass: string;
  agentName: string;
  kind: "llms_txt" | "mcp_tool" | "page";
  toolName: string;
  path: string;
  statusCode: number;
  latencyMs: number;
  userAgent: string;
}

export class NotFoundError extends Error {
  constructor(what = "not found") {
    super(what);
    this.name = "NotFoundError";
  }
}
