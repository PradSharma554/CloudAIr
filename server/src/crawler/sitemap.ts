import { XMLParser } from "fast-xml-parser";
import { USER_AGENT } from "./shared.js";

const MAX_SITEMAP_SEEDS = 200;
const parser = new XMLParser();

/** Seeds the frontier from /sitemap.xml, following one level of sitemap-index nesting. */
export async function fetchSitemap(baseUrl: string): Promise<string[]> {
  return fetchSitemapUrl(`${baseUrl}/sitemap.xml`, 0);
}

async function fetchSitemapUrl(sitemapUrl: string, depth: number): Promise<string[]> {
  if (depth > 1) return [];
  let text: string;
  try {
    const resp = await fetch(sitemapUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return [];
    text = await resp.text();
  } catch {
    return [];
  }

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(text);
  } catch {
    return [];
  }

  const urls: string[] = [];
  const urlset = doc.urlset as { url?: unknown } | undefined;
  if (urlset?.url) {
    for (const entry of asArray(urlset.url)) {
      const loc = (entry as { loc?: unknown }).loc;
      if (typeof loc === "string") urls.push(loc);
      if (urls.length >= MAX_SITEMAP_SEEDS) return urls;
    }
    return urls;
  }

  const index = doc.sitemapindex as { sitemap?: unknown } | undefined;
  if (index?.sitemap) {
    for (const entry of asArray(index.sitemap)) {
      const loc = (entry as { loc?: unknown }).loc;
      if (typeof loc === "string") {
        urls.push(...(await fetchSitemapUrl(loc, depth + 1)));
        if (urls.length >= MAX_SITEMAP_SEEDS) return urls.slice(0, MAX_SITEMAP_SEEDS);
      }
    }
  }
  return urls;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}
