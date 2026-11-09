import { parseReplicas } from "@bulletin/config";
import { createDatabaseCheck, startService } from "@bulletin/config/server";
import { migrationsCurrent, runMigrations } from "@bulletin/db/migrate";
import { runBaseSeedFromEnv } from "@bulletin/db/seed";
import { SQL } from "bun";

const port = Number(Bun.env.PORT ?? 3002);
const databaseUrl = Bun.env.DATABASE_URL ?? "postgres://staff_api@postgres:5432/bulletin";
const migrationUrl = Bun.env.MIGRATION_DATABASE_URL ?? databaseUrl;

await runMigrations({ databaseUrl: migrationUrl });
await runBaseSeedFromEnv(migrationUrl);

const sql = new SQL(databaseUrl);

await startService({
  service: "staff-api",
  port,
  fetch() {
    return Response.json({ service: "staff-api", status: "ok" });
  },
  checks: [createDatabaseCheck(sql), { name: "migrations", check: () => migrationsCurrent(sql) }],
  budget: {
    sql,
    service: "staff-api",
    replicas: parseReplicas(Bun.env.BULLETIN_REPLICAS),
  },
});

console.log(`staff-api listening on http://localhost:${port}`);
