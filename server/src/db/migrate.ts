import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Minimal forward-only migration runner. Files are NNNN_name.sql; the section
 * between "-- +goose Up" and "-- +goose Down" is applied in a transaction and
 * recorded in schema_migrations.
 *
 * Compatibility: this database was originally migrated with goose (the Go
 * toolchain). If a goose_db_version table exists, its history is adopted so
 * already-applied migrations are not re-run.
 */
export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version int PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`
  );

  const goose = await pool.query(`SELECT to_regclass('goose_db_version') AS reg`);
  if (goose.rows[0].reg) {
    const v = await pool.query(`SELECT coalesce(max(version_id), 0) AS v FROM goose_db_version`);
    for (let i = 1; i <= Number(v.rows[0].v); i++) {
      await pool.query(
        `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`,
        [i]
      );
    }
  }

  const applied = new Set(
    (await pool.query(`SELECT version FROM schema_migrations`)).rows.map((r) => Number(r.version))
  );

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const version = Number(file.split("_")[0]);
    if (!Number.isInteger(version)) throw new Error(`bad migration filename: ${file}`);
    if (applied.has(version)) continue;

    const raw = await readFile(path.join(migrationsDir, file), "utf8");
    const up = extractUp(raw, file);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(up);
      await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [version]);
      await client.query("COMMIT");
      console.log(`migrated: ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
}

function extractUp(sql: string, file: string): string {
  const upMarker = "-- +goose Up";
  const downMarker = "-- +goose Down";
  const start = sql.indexOf(upMarker);
  if (start < 0) throw new Error(`${file}: missing "${upMarker}" marker`);
  const end = sql.indexOf(downMarker);
  return sql.slice(start + upMarker.length, end < 0 ? undefined : end).trim();
}
