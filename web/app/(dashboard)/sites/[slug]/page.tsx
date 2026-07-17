"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Crawl, type Site } from "@/lib/api";
import { Badge, Button, Card, CopyField, CrawlBadge, ErrorNote } from "@/components/ui";

export default function SiteOverviewPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const [site, setSite] = useState<Site | null>(null);
  const [crawl, setCrawl] = useState<Crawl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api<Site>(`/sites/${slug}`);
      setSite(s);
      setCrawl(s.latest_crawl ?? null);
      return s;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [slug]);

  // Poll crawl status every 3s while one is running. (On Render's free tier
  // this doubles as a keep-alive for the instance doing the crawl.)
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (crawl?.status !== "running" && crawl?.status !== "queued") return;
    pollRef.current = setInterval(async () => {
      const res = await api<{ crawl: Crawl | null }>(`/sites/${slug}/crawls/latest`).catch(() => null);
      if (res?.crawl) {
        setCrawl(res.crawl);
        if (res.crawl.status !== "running" && res.crawl.status !== "queued") {
          load(); // refresh llms.txt readiness
        }
      }
    }, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [crawl?.status, slug, load]);

  async function startCrawl() {
    setBusy(true);
    setError(null);
    try {
      await api(`/sites/${slug}/crawls`, { method: "POST" });
      const res = await api<{ crawl: Crawl | null }>(`/sites/${slug}/crawls/latest`);
      setCrawl(res.crawl);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ verified: boolean; detail?: string }>(`/sites/${slug}/verify`, { method: "POST" });
      if (!res.verified) setError(`Not verified yet: ${res.detail}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!site) return <p className="text-sm text-zinc-500">{error ?? "Loading…"}</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{site.domain}</h1>
          {site.verified ? <Badge tone="green">verified</Badge> : <Badge tone="yellow">unverified</Badge>}
          <CrawlBadge status={crawl?.status} />
        </div>
        {site.verified && (
          <Button onClick={startCrawl} disabled={busy || crawl?.status === "running"}>
            {crawl?.status === "running" ? "Crawling…" : "Re-crawl"}
          </Button>
        )}
      </div>

      <ErrorNote error={error} />

      {!site.verified && (
        <Card title="Verification required">
          <div className="space-y-4 text-sm text-zinc-600">
            <p>Add this DNS TXT record, then verify:</p>
            <CopyField label="Record name (host)" value={site.dns_record_host} />
            <CopyField label="Record value" value={site.verification_token} />
            <p className="text-xs">
              Or serve the token at <code>{site.well_known_url}</code>
            </p>
            <Button onClick={verify} disabled={busy}>
              {busy ? "Checking…" : "Verify & start first crawl"}
            </Button>
          </div>
        </Card>
      )}

      {crawl?.status === "running" && (
        <Card title="Crawl in progress">
          <div className="space-y-2">
            <div className="h-2 overflow-hidden rounded-full bg-zinc-100">
              <div
                className="h-full rounded-full bg-sky-500 transition-all"
                style={{ width: `${Math.min(100, (crawl.pages_crawled / crawl.max_pages) * 100)}%` }}
              />
            </div>
            <p className="text-xs text-zinc-500">
              {crawl.pages_crawled} / {crawl.max_pages} pages · llms.txt generation runs after the crawl
            </p>
          </div>
        </Card>
      )}

      {crawl?.status === "failed" && crawl.error && (
        <Card title="Last crawl failed">
          <p className="text-sm text-red-600">{crawl.error}</p>
        </Card>
      )}

      {site.verified && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card title="Agent endpoints">
            <div className="space-y-3">
              <CopyField label="llms.txt" value={site.llms_txt_url} />
              <CopyField label="llms-full.txt" value={site.llms_full_txt_url} />
              <CopyField label="MCP endpoint (Streamable HTTP)" value={site.mcp_url} />
            </div>
          </Card>
          <Card title="Put it in front of agents">
            <ol className="list-decimal space-y-2 pl-4 text-sm text-zinc-600">
              <li>
                Redirect <code className="text-xs">{site.domain}/llms.txt</code> → your llms.txt URL
                (301, or serve it directly).
              </li>
              <li>
                Mention the MCP endpoint in your docs so agent developers can
                connect: <code className="text-xs">claude mcp add --transport http {site.slug} {site.mcp_url}</code>
              </li>
              <li>Watch who shows up in the Analytics tab.</li>
            </ol>
          </Card>
        </div>
      )}
    </div>
  );
}
