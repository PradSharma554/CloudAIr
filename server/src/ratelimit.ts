// Per-(site, agent) token-bucket rate limiting.
//
// Buckets live in process memory. On Render's free tier this is correct, not
// just acceptable: there is exactly one instance, so there is no replica to
// disagree with. Limits reset on restart, which only errs permissive. The
// Limiter interface is the seam for a Redis-backed implementation when
// scaling to multiple instances later.
import { LRUCache } from "lru-cache";

export interface AllowResult {
  ok: boolean;
  retryAfterSeconds: number;
}

export interface Limiter {
  allow(key: string, rpm: number, burst: number): AllowResult;
}

interface Bucket {
  tokens: number;
  lastRefill: number; // ms epoch
  rpm: number;
  burst: number;
}

export class MemoryLimiter implements Limiter {
  // 10k buckets ≈ a few MB — bounded memory on a 512MB instance.
  private buckets = new LRUCache<string, Bucket>({ max: 10_000 });

  allow(key: string, rpm: number, burst: number): AllowResult {
    if (rpm <= 0) rpm = 60;
    if (burst <= 0) burst = 10;
    const now = Date.now();
    const ratePerMs = rpm / 60_000;

    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: burst, lastRefill: now, rpm, burst };
      this.buckets.set(key, b);
    } else if (b.rpm !== rpm || b.burst !== burst) {
      // Rules changed since this bucket was created — apply the new
      // parameters instead of serving stale limits until eviction.
      b.rpm = rpm;
      b.burst = burst;
      b.tokens = Math.min(b.tokens, burst);
    }

    b.tokens = Math.min(b.burst, b.tokens + (now - b.lastRefill) * ratePerMs);
    b.lastRefill = now;

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, retryAfterSeconds: 0 };
    }
    const waitMs = (1 - b.tokens) / ratePerMs;
    return { ok: false, retryAfterSeconds: Math.ceil(waitMs / 1000) };
  }
}

type RuleMap = Map<string, [rpm: number, burst: number]>;

export const DEFAULT_RPM = 60;
export const DEFAULT_BURST = 10;

/** Resolves the effective (rpm, burst) for a site + agent, caching DB rules for 60s. */
export class RuleSource {
  private cache = new Map<string, { rules: RuleMap; expires: number }>();

  constructor(private fetchRules: (siteId: string) => Promise<RuleMap>) {}

  /** Precedence: exact agent name → agent class → site '*' → global default. */
  async resolve(siteId: string, agentName: string, agentClass: string): Promise<[number, number]> {
    const rules = await this.rulesFor(siteId);
    if (agentName) {
      const r = rules.get(`agent:${agentName}`);
      if (r) return r;
    }
    const byClass = rules.get(`class:${agentClass}`);
    if (byClass) return byClass;
    const wildcard = rules.get("site:*");
    if (wildcard) return wildcard;
    return [DEFAULT_RPM, DEFAULT_BURST];
  }

  invalidate(siteId: string): void {
    this.cache.delete(siteId);
  }

  private async rulesFor(siteId: string): Promise<RuleMap> {
    const entry = this.cache.get(siteId);
    if (entry && Date.now() < entry.expires) return entry.rules;
    let rules: RuleMap;
    try {
      rules = await this.fetchRules(siteId);
    } catch {
      rules = new Map();
    }
    this.cache.set(siteId, { rules, expires: Date.now() + 60_000 });
    return rules;
  }
}
