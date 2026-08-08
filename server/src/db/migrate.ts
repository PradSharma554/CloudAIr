import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version int PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`
  );

  const applied = new Set(
    (await pool.query(`SELECT version FROM schema_migrations`)).rows.map((r) => Number(r.version))
  );

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const version = Number(file.split("_")[0]);
    if (!Number.isInteger(version)) throw new Error(`bad migration filename: ${file}`);
    if (applied.has(version)) continue;

    const sql = await readFile(path.join(migrationsDir, file), "utf8");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
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
