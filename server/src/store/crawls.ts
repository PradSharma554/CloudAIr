import type pg from "pg";
import { NotFoundError, type Checkpoint, type Crawl, type CrawlStatus } from "./types.js";

const CRAWL_COLS = `id, site_id, status, pages_crawled, max_pages, checkpoint,
  coalesce(error, '') AS error, heartbeat_at, started_at, finished_at, created_at`;

function rowToCrawl(row: Record<string, unknown>): Crawl {
  return {
    id: row.id as string,
    siteId: row.site_id as string,
    status: row.status as CrawlStatus,
    pagesCrawled: Number(row.pages_crawled),
    maxPages: Number(row.max_pages),
    checkpoint: (row.checkpoint as Checkpoint) ?? null,
    error: row.error as string,
    startedAt: (row.started_at as Date) ?? null,
    finishedAt: (row.finished_at as Date) ?? null,
    createdAt: row.created_at as Date,
  };
}

export class CrawlStore {
  constructor(private pool: pg.Pool) {}

  async create(siteId: string, maxPages: number): Promise<Crawl> {
    const r = await this.pool.query(
      `INSERT INTO crawls (site_id, max_pages, status, started_at, heartbeat_at)
       VALUES ($1, $2, 'running', now(), now()) RETURNING ${CRAWL_COLS}`,
      [siteId, maxPages]
    );
    return rowToCrawl(r.rows[0]);
  }

  async latest(siteId: string): Promise<Crawl> {
    const r = await this.pool.query(
      `SELECT ${CRAWL_COLS} FROM crawls WHERE site_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [siteId]
    );
    if (r.rows.length === 0) throw new NotFoundError("no crawls yet");
    return rowToCrawl(r.rows[0]);
  }

  /** The active crawl for a site: running with a fresh heartbeat. */
  async running(siteId: string): Promise<Crawl | null> {
    const r = await this.pool.query(
      `SELECT ${CRAWL_COLS} FROM crawls
       WHERE site_id = $1 AND status = 'running' AND heartbeat_at > now() - interval '2 minutes'
       ORDER BY created_at DESC LIMIT 1`,
      [siteId]
    );
    return r.rows.length > 0 ? rowToCrawl(r.rows[0]) : null;
  }

  /** Records progress and touches the heartbeat in one statement. */
  async checkpoint(crawlId: string, pagesCrawled: number, cp: Checkpoint): Promise<void> {
    await this.pool.query(
      `UPDATE crawls SET pages_crawled = $2, checkpoint = $3, heartbeat_at = now() WHERE id = $1`,
      [crawlId, pagesCrawled, JSON.stringify(cp)]
    );
  }

  async finish(crawlId: string, status: CrawlStatus, errMsg: string): Promise<void> {
    await this.pool.query(
      `UPDATE crawls SET status = $2, error = nullif($3, ''), finished_at = now(), checkpoint = NULL
       WHERE id = $1`,
      [crawlId, status, errMsg]
    );
  }

  /**
   * Marks running crawls whose process died (stale heartbeat) as stalled and
   * returns them so the caller can resume from their checkpoints.
   */
  async reapStalled(): Promise<Crawl[]> {
    const r = await this.pool.query(
      `UPDATE crawls SET status = 'stalled'
       WHERE status = 'running' AND heartbeat_at < now() - interval '2 minutes'
       RETURNING ${CRAWL_COLS}`
    );
    return r.rows.map(rowToCrawl);
  }

  /** Flips a stalled crawl back to running for a resume attempt. */
  async resume(crawlId: string): Promise<void> {
    await this.pool.query(
      `UPDATE crawls SET status = 'running', heartbeat_at = now() WHERE id = $1`,
      [crawlId]
    );
  }
}
