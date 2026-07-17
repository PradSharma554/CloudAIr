// Typed client for the dashboard API (via the /api/backend JWT proxy).

export type Crawl = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "stalled";
  pages_crawled: number;
  max_pages: number;
  error?: string;
  started_at?: string;
  finished_at?: string;
  created_at: string;
};

export type Site = {
  id: string;
  domain: string;
  slug: string;
  verified: boolean;
  verification_method?: string;
  verification_token: string;
  dns_record_host: string;
  well_known_url: string;
  llms_txt_url: string;
  llms_full_txt_url: string;
  mcp_url: string;
  llms_txt_generated: boolean;
  settings: {
    monetization?: { enabled: boolean; price_usd?: number; network?: string; pay_to?: string };
    crawl?: { max_pages?: number };
  };
  created_at: string;
  latest_crawl?: Crawl;
};

export type RateLimitRule = {
  id?: string;
  subject_type: "class" | "agent";
  subject: string;
  rpm: number;
  burst: number;
};

export type TimeseriesPoint = { bucket: string; count: number };
export type TopEntry = { key: string; count: number };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`/api/backend${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `request failed (${resp.status})`);
  }
  return resp.json() as Promise<T>;
}
