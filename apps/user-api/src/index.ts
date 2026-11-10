import { createLogger, loadConfig, loadStorageEnvironment, parseReplicas } from "@bulletin/config";
import {
  createDatabaseCheck,
  createListenerCheck,
  createServiceSql,
  startService,
} from "@bulletin/config/server";
import { syncFlagDefinitions } from "@bulletin/db/flags";
import { migrationsCurrent, runMigrations } from "@bulletin/db/migrate";
import { runBaseSeed } from "@bulletin/db/seed";
import { createAuthService } from "@bulletin/domain/auth";
import { GUEST_PRINCIPAL } from "@bulletin/domain/permissions";
import { CODE_FLAG_DEFINITIONS } from "@bulletin/flags";
import { createStorage } from "@bulletin/storage";
import { announceDismissResponse } from "./announcements.ts";
import { beaconResponse } from "./beacon.ts";
import { boardView } from "./board.ts";
import { draftDeleteResponse, draftGetResponse, draftSaveResponse } from "./drafts.ts";
import { emoticonImageResponse, listEmoticonsResponse } from "./emoticons.ts";
import { forumUnlockResponse } from "./forum-unlock.ts";
import { memberSuggestResponse } from "./members.ts";
import { redirectCountsResponse } from "./redirects.ts";

const config = loadConfig();
const logger = createLogger({ service: "user-api", level: config.logLevel });
const port = config.port;
const databaseUrl = config.databaseUrl;
const migrationUrl = Bun.env.MIGRATION_DATABASE_URL ?? databaseUrl;
const storage = createStorage(loadStorageEnvironment(Bun.env, config.nodeEnv));

await runMigrations({ databaseUrl: migrationUrl });
await runBaseSeed({
  databaseUrl: migrationUrl,
  seed: config.seed,
  size: config.seedSize,
  storage,
});

const sql = createServiceSql("user-api", databaseUrl);
await syncFlagDefinitions(sql, CODE_FLAG_DEFINITIONS);
const listener = await createListenerCheck(sql);
const auth = await createAuthService({
  sql,
  kind: "user",
  issuer: config.authIssuer,
  jwksUrl: config.authJwksUrl,
  tokenUrl: config.authTokenUrl,
  clientId: config.authUserClientId,
  origin: config.userOrigin,
  sessionSecret: config.sessionSecret,
  nodeEnv: config.nodeEnv,
  bootstrapAdmins: config.bootstrapAdmins,
  testEndpoints: config.nodeEnv !== "production",
});

await startService({
  service: "user-api",
  logger,
  port,
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/api/forums/redirect-counts") {
      const response = await auth.handle(request, async ({ session }) =>
        redirectCountsResponse(sql, session?.memberId ?? GUEST_PRINCIPAL, session?.id ?? null),
      );

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "GET" && pathname === "/api/emoticons") {
      return listEmoticonsResponse(sql);
    }

    const emoticonImageMatch = /^\/api\/emoticons\/(\d+)\/image$/.exec(pathname);

    if (request.method === "GET" && emoticonImageMatch !== null) {
      return emoticonImageResponse(sql, storage, emoticonImageMatch[1] ?? "");
    }

    const unlockMatch = /^\/api\/forums\/(\d+)\/unlock$/.exec(pathname);

    if (request.method === "POST" && unlockMatch !== null) {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return forumUnlockResponse(sql, session, unlockMatch[1] ?? "", request);
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const dismissMatch = /^\/api\/announcements\/(\d+)\/dismiss$/.exec(pathname);

    if (request.method === "POST" && dismissMatch !== null) {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return announceDismissResponse(sql, session.memberId, dismissMatch[1] ?? "");
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (pathname === "/api/beacon") {
      if (request.method !== "POST") {
        return Response.json({ code: "method_not_allowed" }, { status: 405 });
      }

      const response = await auth.handle(request, async ({ session }) =>
        beaconResponse(sql, request, {
          session,
          nodeEnv: config.nodeEnv,
          rateLimitSecret: config.sessionSecret,
        }),
      );

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (pathname === "/api/me/drafts") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        if (request.method === "GET") {
          return draftGetResponse(sql, session.memberId, new URL(request.url));
        }

        if (request.method === "PUT") {
          return draftSaveResponse(sql, session.memberId, request);
        }

        if (request.method === "DELETE") {
          return draftDeleteResponse(sql, session.memberId, new URL(request.url));
        }

        return Response.json({ code: "method_not_allowed" }, { status: 405 });
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "GET" && pathname === "/api/members/suggest") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return memberSuggestResponse(sql, new URL(request.url));
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "GET" && pathname === "/api/board") {
      const response = await auth.handle(request, async ({ session }) =>
        Response.json(await boardView(sql, session), {
          headers: { "cache-control": "no-store" },
        }),
      );

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    return (await auth.handle(request)) ?? Response.json({ code: "not_found" }, { status: 404 });
  },
  checks: [
    createDatabaseCheck(sql),
    { name: "migrations", check: () => migrationsCurrent(sql) },
    listener,
  ],
  budget: {
    sql,
    service: "user-api",
    replicas: parseReplicas(Bun.env.BULLETIN_REPLICAS),
  },
  security: { nodeEnv: config.nodeEnv, connectSrc: [config.authIssuer] },
  async onShutdown() {
    await auth.close();
    await listener.close();
    await sql.close();
  },
}).catch(async (error: unknown) => {
  await auth.close();
  await listener.close();
  await sql.close();
  throw error;
});

logger.info("service listening", { port });
