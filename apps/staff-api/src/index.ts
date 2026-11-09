import { runMigrations } from "@bulletin/db/migrate";

const port = Number(Bun.env.PORT ?? 3002);
const databaseUrl = Bun.env.DATABASE_URL ?? "postgres://staff_api@postgres:5432/bulletin";
const migrationUrl = Bun.env.MIGRATION_DATABASE_URL ?? databaseUrl;

await runMigrations({ databaseUrl: migrationUrl });

Bun.serve({
  port,
  fetch() {
    return Response.json({ service: "staff-api", status: "ok" });
  },
});

console.log(`staff-api listening on http://localhost:${port}`);
