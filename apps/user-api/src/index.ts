import { runMigrations } from "@bulletin/db/migrate";

const port = Number(Bun.env.PORT ?? 3001);
const databaseUrl = Bun.env.DATABASE_URL ?? "postgres://user_api@postgres:5432/bulletin";
const migrationUrl = Bun.env.MIGRATION_DATABASE_URL ?? databaseUrl;

await runMigrations({ databaseUrl: migrationUrl });

Bun.serve({
  port,
  fetch() {
    return Response.json({ service: "user-api", status: "ok" });
  },
});

console.log(`user-api listening on http://localhost:${port}`);
