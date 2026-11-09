import { createPgBossQueue } from "@bulletin/db/events";
import { runMigrations } from "@bulletin/db/migrate";

const port = Number(Bun.env.PORT ?? 3003);
const databaseUrl = Bun.env.DATABASE_URL ?? "postgres://workers@postgres:5432/bulletin";
const migrationUrl = Bun.env.MIGRATION_DATABASE_URL ?? databaseUrl;

await runMigrations({ databaseUrl: migrationUrl });

const boss = await createPgBossQueue({
  connectionString: Bun.env.PG_BOSS_DATABASE_URL ?? databaseUrl,
  schema: "pgboss",
});

Bun.serve({
  port,
  fetch() {
    return Response.json({ service: "workers", status: "ok" });
  },
});

console.log(`workers listening on http://localhost:${port}`);

process.on("SIGTERM", () => {
  void boss.stop().finally(() => process.exit(0));
});
