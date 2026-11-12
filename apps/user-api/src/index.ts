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
import { apiTranslator } from "./catalogs.ts";
import {
  archiveConversationResponse,
  conversationResponse,
  createConversationResponse,
  leaveConversationResponse,
  participantResponse,
  readConversationResponse,
  replyConversationResponse,
} from "./conversations.ts";
import { draftsRoute } from "./drafts.ts";
import { emoticonImageResponse, listEmoticonsResponse } from "./emoticons.ts";
import { createUserApiFlags } from "./flag-guard.ts";
import { followResponse, followSettingsResponse } from "./follows.ts";
import { forumUnlockResponse } from "./forum-unlock.ts";
import { memberSuggestResponse } from "./members.ts";
import { moderationActionResponse, queueCountResponse, queueResponse } from "./moderation.ts";
import {
  notificationDigestResponse,
  notificationPreferencesResponse,
  notificationReadResponse,
} from "./notifications.ts";
import { pollEditResponse, pollResultsResponse, pollVoteResponse } from "./polls.ts";
import { profileSaveResponse } from "./profile.ts";
import { reactionMembersResponse, reactionSetResponse } from "./reactions.ts";
import { markBoardReadResponse, markForumReadResponse } from "./read-tracking.ts";
import { redirectCountsResponse } from "./redirects.ts";
import { friendResponse, ignoreResponse, relationshipStateResponse } from "./relationships.ts";
import {
  createReportResponse,
  reportActionResponse,
  reportDetailResponse,
  reportsListResponse,
} from "./reports.ts";
import { reputationGiveResponse } from "./reputation.ts";
import { streamResponse } from "./stream.ts";
import { createStreamHub } from "./stream-hub.ts";
import {
  createTopicResponse,
  editPostResponse,
  postDeleteResponse,
  postHistoryResponse,
  replyResponse,
  topicDeleteResponse,
} from "./topics.ts";
import { unsubscribeResponse } from "./unsubscribe.ts";

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
const streamHub = await createStreamHub(sql);
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
  featureEnabled: (key, memberId) => flags.enabled(key, memberId),
  translateFor: apiTranslator,
});

await startService({
  service: "user-api",
  logger,
  port,
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/stream") {
      if (request.method !== "GET") {
        return Response.json({ code: "method_not_allowed" }, { status: 405 });
      }

      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return flags.guard("realtime", session.memberId)(request, async () =>
          streamResponse({
            sql,
            session,
            request,
            hub: streamHub,
            conversationsEnabled: await flags.enabled("conversations", session.memberId),
          }),
        );
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    // Authenticated by the signed token, not a session (ADR 0018 exemption); a mail client's
    // RFC 8058 one-click POST has no Origin header.
    if (pathname === "/api/notifications/unsubscribe") {
      if (request.method !== "POST") {
        return Response.json({ code: "method_not_allowed" }, { status: 405 });
      }

      return unsubscribeResponse(
        sql,
        { secret: config.sessionSecret, userOrigin: config.userOrigin },
        request,
      );
    }

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

    if (request.method === "POST" && pathname === "/api/notifications/digest") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return flags.guard("digests", session.memberId)(request, () =>
          notificationDigestResponse(sql, session.memberId, request),
        );
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "POST" && pathname === "/api/notifications/preferences") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return flags.guard("notifications", session.memberId)(request, () =>
          notificationPreferencesResponse(sql, session.memberId, request),
        );
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "POST" && pathname === "/api/notifications/read") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return flags.guard("notifications", session.memberId)(request, () =>
          notificationReadResponse(sql, session.memberId, request),
        );
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "POST" && pathname === "/api/follows") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return flags.guard("follows", session.memberId)(request, () =>
          followResponse(sql, session, request),
        );
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "POST" && pathname === "/api/me/follow-settings") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return flags.guard("follows", session.memberId)(request, () =>
          followSettingsResponse(sql, session, request),
        );
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "POST" && pathname === "/api/me/profile") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        const [customFields, signatures, badges] = await Promise.all([
          flags.enabled("custom_profile_fields", session.memberId),
          flags.enabled("signatures", session.memberId),
          flags.enabled("badges", session.memberId),
        ]);

        return profileSaveResponse(sql, session, request, {
          customFields,
          signatures,
          customTitles: true,
          badges,
        });
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "GET" && pathname === "/api/relationships/state") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        const [friendsOn, ignoreOn] = await Promise.all([
          flags.enabled("friends", session.memberId),
          flags.enabled("ignore_list", session.memberId),
        ]);

        if (!friendsOn && !ignoreOn) {
          return Response.json({ code: "not_found" }, { status: 404 });
        }

        return relationshipStateResponse(sql, session, new URL(request.url));
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "POST" && pathname === "/api/ignores") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return flags.guard("ignore_list", session.memberId)(request, () =>
          ignoreResponse(sql, session, request),
        );
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "POST" && pathname === "/api/friends") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return flags.guard("friends", session.memberId)(request, () =>
          friendResponse(sql, session, request),
        );
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

    const reactionMatch = /^\/api\/posts\/(\d+)\/reactions$/.exec(pathname);

    if (reactionMatch !== null) {
      const postId = reactionMatch[1] ?? "";

      if (request.method === "GET") {
        const response = await auth.handle(request, async ({ session }) =>
          flags.guard("reactions", session?.memberId ?? null)(request, () =>
            reactionMembersResponse(sql, session, postId, new URL(request.url)),
          ),
        );

        return response ?? Response.json({ code: "not_found" }, { status: 404 });
      }

      if (request.method === "POST") {
        const response = await auth.handle(request, async ({ session }) => {
          if (session === null) {
            return Response.json({ code: "unauthenticated" }, { status: 401 });
          }

          return flags.guard("reactions", session.memberId)(request, () =>
            reactionSetResponse(sql, session, postId, request),
          );
        });

        return response ?? Response.json({ code: "not_found" }, { status: 404 });
      }

      return Response.json({ code: "method_not_allowed" }, { status: 405 });
    }

    const reputationMatch = /^\/api\/posts\/(\d+)\/reputation$/.exec(pathname);

    if (reputationMatch !== null) {
      if (request.method !== "POST") {
        return Response.json({ code: "method_not_allowed" }, { status: 405 });
      }

      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return flags.guard("reputation", session.memberId)(request, () =>
          reputationGiveResponse(sql, session, reputationMatch[1] ?? "", request),
        );
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "POST" && pathname === "/api/conversations") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return flags.guard("conversations", session.memberId)(request, () =>
          createConversationResponse(sql, session, request),
        );
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const conversationMatch = /^\/api\/conversations\/(\d+)$/.exec(pathname);

    if (request.method === "GET" && conversationMatch !== null) {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return flags.guard("conversations", session.memberId)(request, () =>
          conversationResponse(sql, session, conversationMatch[1] ?? ""),
        );
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const conversationArchiveMatch = /^\/api\/conversations\/(\d+)\/archive$/.exec(pathname);

    if (request.method === "POST" && conversationArchiveMatch !== null) {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return flags.guard("conversations", session.memberId)(request, () =>
          archiveConversationResponse(sql, session, conversationArchiveMatch[1] ?? "", request),
        );
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const conversationReadMatch = /^\/api\/conversations\/(\d+)\/read$/.exec(pathname);

    if (request.method === "POST" && conversationReadMatch !== null) {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return flags.guard("conversations", session.memberId)(request, () =>
          readConversationResponse(sql, session, conversationReadMatch[1] ?? "", request),
        );
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const conversationReplyMatch = /^\/api\/conversations\/(\d+)\/replies$/.exec(pathname);

    if (request.method === "POST" && conversationReplyMatch !== null) {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return flags.guard("conversations", session.memberId)(request, () =>
          replyConversationResponse(sql, session, conversationReplyMatch[1] ?? "", request),
        );
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const conversationParticipantsMatch = /^\/api\/conversations\/(\d+)\/participants$/.exec(
      pathname,
    );

    if (request.method === "POST" && conversationParticipantsMatch !== null) {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return flags.guard("conversations", session.memberId)(request, () =>
          participantResponse(sql, session, conversationParticipantsMatch[1] ?? "", request),
        );
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const conversationLeaveMatch = /^\/api\/conversations\/(\d+)\/leave$/.exec(pathname);

    if (request.method === "POST" && conversationLeaveMatch !== null) {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return flags.guard("conversations", session.memberId)(request, () =>
          leaveConversationResponse(sql, session, conversationLeaveMatch[1] ?? "", request),
        );
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "GET" && pathname === "/api/moderation/queue") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return queueResponse(sql, session, request);
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "GET" && pathname === "/api/moderation/count") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return queueCountResponse(sql, session);
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "POST" && pathname === "/api/reports") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return createReportResponse(sql, session, request);
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "GET" && pathname === "/api/reports") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return reportsListResponse(sql, session, request);
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    const reportMatch = /^\/api\/reports\/(\d+)$/.exec(pathname);

    if (reportMatch !== null) {
      const reportId = reportMatch[1] ?? "";
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        if (request.method === "GET") {
          return reportDetailResponse(sql, session, reportId);
        }

        if (request.method === "POST") {
          return reportActionResponse(sql, session, reportId, request);
        }

        return Response.json({ code: "method_not_allowed" }, { status: 405 });
      });

      return response ?? Response.json({ code: "not_found" }, { status: 404 });
    }

    if (request.method === "POST" && pathname === "/api/moderation/actions") {
      const response = await auth.handle(request, async ({ session }) => {
        if (session === null) {
          return Response.json({ code: "unauthenticated" }, { status: 401 });
        }

        return moderationActionResponse(sql, session, request);
      });

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
          followsEnabled: await flags.enabled("follows", session.memberId),
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

        return replyResponse(sql, session, replyMatch[1] ?? "", request, {
          followsEnabled: await flags.enabled("follows", session.memberId),
        });
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
    await streamHub.close();
    await auth.close();
    await listener.close();
    await sql.close();
  },
}).catch(async (error: unknown) => {
  await streamHub.close();
  await auth.close();
  await listener.close();
  await sql.close();
  throw error;
});

logger.info("service listening", { port });
