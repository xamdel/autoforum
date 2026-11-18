import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, types as pgTypes } from "pg";

import * as schema from "./schema.ts";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

pgTypes.setTypeParser(20, (value) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Database identifier exceeds JavaScript's safe integer range: ${value}`);
  return parsed;
});

export function createDatabase(connectionString: string, onIdleError?: (error: unknown) => void) {
  const pool = new Pool({
    connectionString,
    application_name: "autoforum-api",
  });
  pool.on("error", (error) => {
    // pg removes the failed idle client. Keeping a listener prevents EventEmitter from
    // turning a recoverable connection loss into an unhandled process exception.
    if (onIdleError) onIdleError(error);
    else console.error("Postgres idle client error", error);
  });
  const client = drizzle(pool, { schema });

  return {
    pool,
    client,
    async migrate(): Promise<void> {
      await migrate(client, { migrationsFolder });
    },
    async check(): Promise<void> {
      await pool.query("select 1");
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

export type AppDatabase = ReturnType<typeof createDatabase>;
