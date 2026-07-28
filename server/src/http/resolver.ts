// SiteResolver is the seam that makes reverse-proxy mode an add-on instead
// of a rewrite: PathResolver handles /sites/{slug}/... today, HostResolver
// maps <slug><HOST_SUFFIX> hosts onto the same canonical path form, so one
// router serves both modes.
import type { Request } from "express";
import { LRUCache } from "lru-cache";
import type { SiteStore } from "../store/sites.js";
import type { Site } from "../store/types.js";

/** Small TTL cache so hot sites don't hit Postgres on every agent request. */
export class SiteCache {
  private cache = new LRUCache<string, Site>({ max: 1024, ttl: 30_000 });

  constructor(private sites: SiteStore) {}

  async bySlug(slug: string): Promise<Site | null> {
    const hit = this.cache.get(slug);
    if (hit) return hit;
    try {
      const site = await this.sites.bySlug(slug);
      this.cache.set(slug, site);
      return site;
    } catch {
      return null;
    }
  }

  invalidate(slug: string): void {
    this.cache.delete(slug);
  }
}

/**
 * Matches <slug><suffix> hosts (e.g. example-com.cloudair.dev) and returns
 * the slug — the first step toward reverse-proxy mode. Returns null when the
 * host doesn't match.
 */
export function hostSlug(req: Request, suffix: string): string | null {
  if (!suffix) return null;
  const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
  if (!host.endsWith(suffix)) return null;
  const slug = host.slice(0, -suffix.length);
  if (!slug || slug.includes(".")) return null;
  return slug;
}
