import type pg from "pg";
import type { AgentRequestEvent, RateLimitRule } from "./types.js";

export interface TimeseriesPoint {
  bucket: Date;
  count: number;
}

export interface TopEntry {
  key: string;
  count: number;
}

export class AnalyticsStore {
  constructor(private pool: pg.Pool) {}

  /** Bulk-inserts buffered analytics events (one multi-row statement). */
  async insertEvents(events: AgentRequestEvent[]): Promise<void> {
    if (events.length === 0) return;
    const cols = 10;
    const values: unknown[] = [];
    const tuples = events.map((e, i) => {
      values.push(
        e.siteId, e.ts, e.agentClass, e.agentName || null, e.kind,
        e.toolName || null, e.path, e.statusCode, e.latencyMs, e.userAgent.slice(0, 256)
      );
      const base = i * cols;
      return `(${Array.from({ length: cols }, (_, j) => `$${base + j + 1}`).join(", ")})`;
    });
    await this.pool.query(
      `INSERT INTO agent_requests
         (site_id, ts, agent_class, agent_name, kind, tool_name, path, status_code, latency_ms, user_agent)
       VALUES ${tuples.join(", ")}`,
      values
    );
  }

  async timeseries(siteId: string, since: Date, bucket: "hour" | "day"): Promise<TimeseriesPoint[]> {
    const r = await this.pool.query(
      `SELECT date_trunc($3, ts) AS bucket, count(*)::int AS count
       FROM agent_requests WHERE site_id = $1 AND ts >= $2
       GROUP BY 1 ORDER BY 1`,
      [siteId, since, bucket]
    );
    return r.rows as TimeseriesPoint[];
  }

  async top(siteId: string, by: string, since: Date, limit: number): Promise<TopEntry[]> {
    const col =
      {
        agent: `coalesce(agent_name, 'unidentified')`,
        path: `coalesce(path, '')`,
        tool: `coalesce(tool_name, '')`,
        class: `agent_class`,
      }[by] ?? `coalesce(agent_name, 'unidentified')`;
    const cap = limit > 0 && limit <= 50 ? limit : 10;
    const r = await this.pool.query(
      `SELECT ${col} AS key, count(*)::int AS count
       FROM agent_requests WHERE site_id = $1 AND ts >= $2
       GROUP BY 1 ORDER BY 2 DESC LIMIT $3`,
      [siteId, since, cap]
    );
    return r.rows as TopEntry[];
  }

  /**
   * Folds raw events older than today into permanent daily rollups, then
   * prunes raw events past 30-day retention (daily cron; keeps Neon's 0.5GB
   * budget honest).
   */
  async rollupAndPrune(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO agent_requests_daily (site_id, day, agent_class, agent_name, kind, request_count)
         SELECT site_id, ts::date, agent_class, coalesce(agent_name, ''), kind, count(*)::int
         FROM agent_requests WHERE ts < date_trunc('day', now())
         GROUP BY 1, 2, 3, 4, 5
         ON CONFLICT (site_id, day, agent_class, agent_name, kind)
         DO UPDATE SET request_count = EXCLUDED.request_count`
      );
      await client.query(`DELETE FROM agent_requests WHERE ts < now() - interval '30 days'`);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async listRateLimitRules(siteId: string): Promise<RateLimitRule[]> {
    const r = await this.pool.query(
      `SELECT id, subject_type, subject, rpm, burst
       FROM rate_limit_rules WHERE site_id = $1 ORDER BY subject_type, subject`,
      [siteId]
    );
    return r.rows as RateLimitRule[];
  }

  /**
   * Rules keyed for the limiter's precedence lookup:
   * "agent:<name>", "class:<class>", and "site:*" for the wildcard.
   */
  async rateLimitRuleMap(siteId: string): Promise<Map<string, [number, number]>> {
    const rules = await this.listRateLimitRules(siteId);
    const m = new Map<string, [number, number]>();
    for (const r of rules) {
      const key = r.subject === "*" ? "site:*" : `${r.subject_type}:${r.subject}`;
      m.set(key, [r.rpm, r.burst]);
    }
    return m;
  }

  /** Swaps a site's full rule set atomically (the settings UI submits the whole list). */
  async replaceRateLimitRules(siteId: string, rules: RateLimitRule[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM rate_limit_rules WHERE site_id = $1`, [siteId]);
      for (const r of rules) {
        await client.query(
          `INSERT INTO rate_limit_rules (site_id, subject_type, subject, rpm, burst)
           VALUES ($1, $2, $3, $4, $5)`,
          [siteId, r.subject_type, r.subject, r.rpm, r.burst]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
