import pg from "pg";

// Neon free tier suspends compute when idle; short idle timeouts make us
// reconnect cleanly after a resume instead of erroring on a dead socket.
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 2 * 60 * 1000,
    connectionTimeoutMillis: 10 * 1000,
  });
}

export async function dbHealth(pool: pg.Pool): Promise<string> {
  try {
    await pool.query("SELECT 1");
    return "ok";
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
}

/** Surfaced on /healthz so Neon free-tier storage growth is visible early. */
export async function dbSizeBytes(pool: pg.Pool): Promise<number> {
  const r = await pool.query("SELECT pg_database_size(current_database()) AS size");
  return Number(r.rows[0].size);
}
