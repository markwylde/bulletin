import { parseReplicas } from "@bulletin/config";
import { createDatabaseCheck, startService } from "@bulletin/config/server";
import { migrationsCurrent, runMigrations } from "@bulletin/db/migrate";
import { runBaseSeedFromEnv } from "@bulletin/db/seed";
import { SQL } from "bun";

const port = Number(Bun.env.PORT ?? 3001);
const databaseUrl = Bun.env.DATABASE_URL ?? "postgres://user_api@postgres:5432/bulletin";
const migrationUrl = Bun.env.MIGRATION_DATABASE_URL ?? databaseUrl;

await runMigrations({ databaseUrl: migrationUrl });
await runBaseSeedFromEnv(migrationUrl);

const sql = new SQL(databaseUrl);

await startService({
  service: "user-api",
  port,
  fetch() {
    return Response.json({ service: "user-api", status: "ok" });
  },
  checks: [createDatabaseCheck(sql), { name: "migrations", check: () => migrationsCurrent(sql) }],
  budget: {
    sql,
    service: "user-api",
    replicas: parseReplicas(Bun.env.BULLETIN_REPLICAS),
  },
});

console.log(`user-api listening on http://localhost:${port}`);
