import path from "node:path";
import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
import type pg from "pg";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Forward-only migration run, executed on boot before the server accepts
 * traffic. Files are plain .sql with no direction markers, so node-pg-migrate
 * treats each whole file as the "up" and disables "down".
 *
 * Locking is left enabled: it takes a Postgres advisory lock so two instances
 * booting at once can't race to apply the same migration.
 */
export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await runner({
      dbClient: client,
      dir: migrationsDir,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: (msg: string) => console.log(msg),
    });
  } finally {
    client.release();
  }
}
