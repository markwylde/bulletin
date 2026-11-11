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
import {
  attachmentDeleteRoute,
  attachmentDownloadCountRoute,
  attachmentFinaliseRoute,
  attachmentRequestRoute,
} from "./attachments.ts";
import { avatarRemoveRoute, avatarUploadRoute } from "./avatars.ts";
import { beaconResponse } from "./beacon.ts";
import { boardView } from "./board.ts";
import { draftsRoute } from "./drafts.ts";
import { emoticonImageResponse, listEmoticonsResponse } from "./emoticons.ts";
import { createUserApiFlags } from "./flag-guard.ts";
import { forumUnlockResponse } from "./forum-unlock.ts";
import { memberSuggestResponse } from "./members.ts";
import { pollEditResponse, pollResultsResponse, pollVoteResponse } from "./polls.ts";
import { markBoardReadResponse, markForumReadResponse } from "./read-tracking.ts";
import { redirectCountsResponse } from "./redirects.ts";
import {
  createTopicResponse,
  editPostResponse,
  postDeleteResponse,
  postHistoryResponse,
  replyResponse,
  topicDeleteResponse,
} from "./topics.ts";

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
const flags = createUserApiFlags(sql);
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
      return emoticonImageResponse(sql, storage, emoticonImageMatch[1] ?? "", request);
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

    const markForumReadMatch = /^\/api\/forums\/(\d+)\/read$/.exec(pathname);

    if (request.method === "POST" && markForumReadMatch !== null) {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return markForumReadResponse(sql, session.memberId, markForumReadMatch[1] ?? "");
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "POST" && pathname === "/api/me/read-all") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return markBoardReadResponse(sql, session.memberId);
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const pollVoteMatch = /^\/api\/polls\/(\d+)\/vote$/.exec(pathname);

    if (request.method === "POST" && pollVoteMatch !== null) {
      const response = await auth.handle(request, async ({ session }) =>
        flags.guard("polls", session?.memberId ?? null)(request, async () => {
          if (session === null) {
            return Response.json({ code: "unauthenticated" }, { status: 401 });
          }

          return pollVoteResponse(sql, session, pollVoteMatch[1] ?? "", request);
        }),
      );

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const pollResultsMatch = /^\/api\/polls\/(\d+)\/results$/.exec(pathname);

    if (request.method === "GET" && pollResultsMatch !== null) {
      const response = await auth.handle(request, async ({ session }) =>
        flags.guard("polls", session?.memberId ?? null)(request, () =>
          pollResultsResponse(sql, session, pollResultsMatch[1] ?? ""),
        ),
      );

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const pollEditMatch = /^\/api\/polls\/(\d+)\/edit$/.exec(pathname);

    if (request.method === "POST" && pollEditMatch !== null) {
      const response = await auth.handle(request, async ({ session }) =>
        flags.guard("polls", session?.memberId ?? null)(request, async () => {
          if (session === null) {
            return Response.json({ code: "unauthenticated" }, { status: 401 });
          }

          return pollEditResponse(sql, session, pollEditMatch[1] ?? "", request);
        }),
      );

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const createTopicMatch = /^\/api\/forums\/(\d+)\/topics$/.exec(pathname);

    if (request.method === "POST" && createTopicMatch !== null) {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return createTopicResponse(sql, session, createTopicMatch[1] ?? "", request, {
          pollsEnabled: await flags.enabled("polls", session.memberId),
        });
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const replyMatch = /^\/api\/topics\/(\d+)\/replies$/.exec(pathname);

    if (request.method === "POST" && replyMatch !== null) {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return replyResponse(sql, session, replyMatch[1] ?? "", request);
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const topicDeleteMatch = /^\/api\/topics\/(\d+)\/delete$/.exec(pathname);

    if (request.method === "POST" && topicDeleteMatch !== null) {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return topicDeleteResponse(sql, session, topicDeleteMatch[1] ?? "", request);
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const editPostMatch = /^\/api\/posts\/(\d+)\/edit$/.exec(pathname);

    if (request.method === "POST" && editPostMatch !== null) {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return editPostResponse(sql, session, editPostMatch[1] ?? "", request);
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const postHistoryMatch = /^\/api\/posts\/(\d+)\/history$/.exec(pathname);

    if (request.method === "GET" && postHistoryMatch !== null) {
      const response = await auth.handle(request, async ({ session }) =>
        postHistoryResponse(sql, session, postHistoryMatch[1] ?? ""),
      );

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const postDeleteMatch = /^\/api\/posts\/(\d+)\/delete$/.exec(pathname);

    if (request.method === "POST" && postDeleteMatch !== null) {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return postDeleteResponse(sql, session, postDeleteMatch[1] ?? "", request);
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "POST" && pathname === "/api/attachments") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return attachmentRequestRoute(sql, storage, flags, session, request);
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const attachmentFinaliseMatch = /^\/api\/attachments\/(\d+)\/finalise$/.exec(pathname);

    if (request.method === "POST" && attachmentFinaliseMatch !== null) {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return attachmentFinaliseRoute(
          sql,
          storage,
          flags,
          session,
          attachmentFinaliseMatch[1] ?? "",
        );
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const attachmentDownloadMatch = /^\/api\/attachments\/(\d+)\/download$/.exec(pathname);

    if (request.method === "POST" && attachmentDownloadMatch !== null) {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return attachmentDownloadCountRoute(sql, flags, session, attachmentDownloadMatch[1] ?? "");
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const attachmentDeleteMatch = /^\/api\/attachments\/(\d+)\/delete$/.exec(pathname);

    if (request.method === "POST" && attachmentDeleteMatch !== null) {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return attachmentDeleteRoute(sql, flags, session, attachmentDeleteMatch[1] ?? "", request);
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "POST" && pathname === "/api/me/avatar") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return avatarUploadRoute(sql, storage, flags, session, request);
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "POST" && pathname === "/api/me/avatar/remove") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return avatarRemoveRoute(sql, storage, flags, session);
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const drafts = await draftsRoute(auth, sql, request);

    if (drafts !== null) {
      return drafts;
    }

    if (request.method === "GET" && pathname === "/api/members/suggest") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return flags.guard("mentions", session.memberId)(request, () =>
          memberSuggestResponse(sql, new URL(request.url)),
        );
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
