import { defineMiddleware } from "astro:middleware";
import {
  createDatabaseCheck,
  createListenerCheck,
  createServiceSql,
} from "@bulletin/config/server";
import { migrationsCurrent } from "@bulletin/db/migrate";

const databaseUrl = Bun.env.DATABASE_URL ?? "postgres://user_app@postgres:5432/bulletin";
const sql = import.meta.env.DEV ? createServiceSql("user-app", databaseUrl) : null;
const listener = sql === null ? null : createListenerCheck(sql);
const databaseCheck = sql === null ? null : createDatabaseCheck(sql);

export const onRequest = defineMiddleware(async (context, next) => {
  if (context.url.pathname === "/health/live") {
    return Response.json({ status: "ok", service: "user-app" });
  }

  if (context.url.pathname === "/health/ready") {
    if (sql === null || databaseCheck === null || listener === null) {
      return Response.json({ status: "ok", checks: {} });
    }

    const checks = { database: false, migrations: false, listener: false };

    try {
      checks.database = await databaseCheck.check();
    } catch {
      checks.database = false;
    }

    try {
      checks.migrations = await migrationsCurrent(sql);
    } catch {
      checks.migrations = false;
    }

    try {
      checks.listener = await (await listener).check();
    } catch {
      checks.listener = false;
    }

    const ready = Object.values(checks).every(Boolean);
    return Response.json(
      { status: ready ? "ok" : "unavailable", checks },
      { status: ready ? 200 : 503 },
    );
  }

  return next();
});
