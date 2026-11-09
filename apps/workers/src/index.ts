import { parseReplicas } from "@bulletin/config";
import { createDatabaseCheck, startService } from "@bulletin/config/server";
import { createPgBossQueue } from "@bulletin/db/events";
import { migrationsCurrent, runMigrations } from "@bulletin/db/migrate";
import { SQL } from "bun";

const port = Number(Bun.env.PORT ?? 3003);
const databaseUrl = Bun.env.DATABASE_URL ?? "postgres://workers@postgres:5432/bulletin";
const migrationUrl = Bun.env.MIGRATION_DATABASE_URL ?? databaseUrl;

await runMigrations({ databaseUrl: migrationUrl });

const sql = new SQL(databaseUrl);
const boss = await createPgBossQueue({
  connectionString: Bun.env.PG_BOSS_DATABASE_URL ?? databaseUrl,
  schema: "pgboss",
});

await startService({
  service: "workers",
  port,
  fetch() {
    return Response.json({ service: "workers", status: "ok" });
  },
  checks: [createDatabaseCheck(sql), { name: "migrations", check: () => migrationsCurrent(sql) }],
  budget: {
    sql,
    service: "workers",
    replicas: parseReplicas(Bun.env.BULLETIN_REPLICAS),
  },
  onShutdown: () => boss.stop(),
}).catch(async (error: unknown) => {
  await boss.stop();
  throw error;
});

console.log(`workers listening on http://localhost:${port}`);
