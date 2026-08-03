import type pg from "pg";
import { NotFoundError, type Site, type SiteSettings, type User } from "./types.js";

const SITE_COLS = `id, user_id, domain, slug, verification_token,
  coalesce(verification_method, '') AS verification_method, verified_at,
  coalesce(llms_txt, '') AS llms_txt, llms_txt_generated_at, settings, created_at`;

function rowToSite(row: Record<string, unknown>): Site {
  const settings = (row.settings ?? {}) as Partial<SiteSettings>;
  return {
    id: row.id as string,
    userId: row.user_id as string,
    domain: row.domain as string,
    slug: row.slug as string,
    verificationToken: row.verification_token as string,
    verificationMethod: row.verification_method as string,
    verifiedAt: row.verified_at as Date | null,
    llmsTxt: row.llms_txt as string,
    llmsTxtGeneratedAt: row.llms_txt_generated_at as Date | null,
    settings: {
      crawl: settings.crawl ?? {},
    },
    createdAt: row.created_at as Date,
  };
}

export class SiteStore {
  constructor(private pool: pg.Pool) {}

  /** Lazily creates the user on first authenticated request (no Auth.js DB adapter). */
  async upsertUser(provider: string, providerId: string, email: string, name: string): Promise<User> {
    const r = await this.pool.query(
      `INSERT INTO users (provider, provider_id, email, name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, provider_id)
       DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
       RETURNING id, email, coalesce(name, '') AS name`,
      [provider, providerId, email, name]
    );
    return { id: r.rows[0].id, provider, providerId, email: r.rows[0].email, name: r.rows[0].name };
  }

  async create(userId: string, domain: string, slug: string, token: string): Promise<Site> {
    const r = await this.pool.query(
      `INSERT INTO sites (user_id, domain, slug, verification_token)
       VALUES ($1, $2, $3, $4) RETURNING ${SITE_COLS}`,
      [userId, domain, slug, token]
    );
    return rowToSite(r.rows[0]);
  }

  async byId(id: string): Promise<Site> {
    return this.one(`SELECT ${SITE_COLS} FROM sites WHERE id = $1`, [id]);
  }

  async bySlug(slug: string): Promise<Site> {
    return this.one(`SELECT ${SITE_COLS} FROM sites WHERE slug = $1`, [slug]);
  }

  async listByUser(userId: string): Promise<Site[]> {
    const r = await this.pool.query(
      `SELECT ${SITE_COLS} FROM sites WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return r.rows.map(rowToSite);
  }

  async listVerified(): Promise<Site[]> {
    const r = await this.pool.query(
      `SELECT ${SITE_COLS} FROM sites WHERE verified_at IS NOT NULL ORDER BY created_at`
    );
    return r.rows.map(rowToSite);
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM sites WHERE id = $1`, [id]);
  }

  async markVerified(id: string, method: string): Promise<void> {
    await this.pool.query(
      `UPDATE sites SET verification_method = $2, verified_at = now() WHERE id = $1`,
      [id, method]
    );
  }

  async updateLlmsTxt(id: string, llmsTxt: string): Promise<void> {
    await this.pool.query(
      `UPDATE sites SET llms_txt = $2, llms_txt_generated_at = now() WHERE id = $1`,
      [id, llmsTxt]
    );
  }

  async updateSettings(id: string, settings: SiteSettings): Promise<void> {
    await this.pool.query(`UPDATE sites SET settings = $2 WHERE id = $1`, [id, JSON.stringify(settings)]);
  }

  private async one(sql: string, params: unknown[]): Promise<Site> {
    const r = await this.pool.query(sql, params);
    if (r.rows.length === 0) throw new NotFoundError("site not found");
    return rowToSite(r.rows[0]);
  }
}
