import type pg from "pg";
import { NotFoundError, type Page, type SearchResult } from "./types.js";

const PAGE_COLS = `id, site_id, url, path, coalesce(title, '') AS title,
  coalesce(meta_desc, '') AS meta_desc, content_hash, markdown,
  coalesce(summary, '') AS summary, coalesce(summary_hash, '') AS summary_hash, fetched_at`;

function rowToPage(row: Record<string, unknown>): Page {
  return {
    id: row.id as string,
    siteId: row.site_id as string,
    url: row.url as string,
    path: row.path as string,
    title: row.title as string,
    metaDesc: row.meta_desc as string,
    contentHash: row.content_hash as string,
    markdown: (row.markdown as string) ?? "",
    summary: row.summary as string,
    summaryHash: row.summary_hash as string,
    fetchedAt: (row.fetched_at as Date) ?? null,
  };
}

export class PageStore {
  constructor(private pool: pg.Pool) {}

  /**
   * Stores a crawled page. The existing summary survives when content is
   * unchanged, so recrawls of unchanged pages cost zero LLM quota.
   */
  async upsert(p: Omit<Page, "id" | "summary" | "summaryHash" | "fetchedAt">): Promise<void> {
    await this.pool.query(
      `INSERT INTO pages (site_id, url, path, title, meta_desc, content_hash, markdown, http_status, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 200, now())
       ON CONFLICT (site_id, url) DO UPDATE SET
         path = EXCLUDED.path, title = EXCLUDED.title, meta_desc = EXCLUDED.meta_desc,
         content_hash = EXCLUDED.content_hash, markdown = EXCLUDED.markdown, fetched_at = now()`,
      [p.siteId, p.url, p.path, p.title, p.metaDesc, p.contentHash, p.markdown]
    );
  }

  async setSummary(siteId: string, url: string, summary: string, summaryHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE pages SET summary = $3, summary_hash = $4 WHERE site_id = $1 AND url = $2`,
      [siteId, url, summary, summaryHash]
    );
  }

  async byPath(siteId: string, pagePath: string): Promise<Page> {
    const r = await this.pool.query(
      `SELECT ${PAGE_COLS} FROM pages WHERE site_id = $1 AND path = $2 ORDER BY fetched_at DESC LIMIT 1`,
      [siteId, pagePath]
    );
    if (r.rows.length === 0) throw new NotFoundError("page not found");
    return rowToPage(r.rows[0]);
  }

  /** Metadata only — markdown bodies excluded. */
  async list(siteId: string): Promise<Page[]> {
    const r = await this.pool.query(
      `SELECT id, site_id, url, path, coalesce(title, '') AS title,
              coalesce(meta_desc, '') AS meta_desc, content_hash, '' AS markdown,
              coalesce(summary, '') AS summary, coalesce(summary_hash, '') AS summary_hash, fetched_at
       FROM pages WHERE site_id = $1 ORDER BY path`,
      [siteId]
    );
    return r.rows.map(rowToPage);
  }

  /** Streams full page bodies one at a time (for llms-full.txt and summarization). */
  async *iterateFull(siteId: string): AsyncGenerator<Page> {
    const ids = await this.pool.query(
      `SELECT id FROM pages WHERE site_id = $1 ORDER BY path`,
      [siteId]
    );
    for (const { id } of ids.rows) {
      const r = await this.pool.query(`SELECT ${PAGE_COLS} FROM pages WHERE id = $1`, [id]);
      if (r.rows.length > 0) yield rowToPage(r.rows[0]);
    }
  }

  async search(siteId: string, query: string, limit: number): Promise<SearchResult[]> {
    const cap = limit > 0 && limit <= 20 ? limit : 5;
    const r = await this.pool.query(
      `SELECT path, url, coalesce(title, '') AS title, coalesce(summary, '') AS summary,
              ts_headline('english', left(markdown, 20000), websearch_to_tsquery('english', $2),
                          'MaxFragments=2, MaxWords=30, MinWords=10') AS snippet
       FROM pages
       WHERE site_id = $1 AND tsv @@ websearch_to_tsquery('english', $2)
       ORDER BY ts_rank(tsv, websearch_to_tsquery('english', $2)) DESC
       LIMIT $3`,
      [siteId, query, cap]
    );
    return r.rows as SearchResult[];
  }

  /** Removes pages not seen in the latest crawl. */
  async deleteStale(siteId: string, before: Date): Promise<void> {
    await this.pool.query(`DELETE FROM pages WHERE site_id = $1 AND fetched_at < $2`, [siteId, before]);
  }
}
