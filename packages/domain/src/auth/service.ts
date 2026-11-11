import { isLocale, type Locale } from "@bulletin/i18n";
import type { SQL } from "bun";
import { readBoardSettings } from "../board/index.ts";
import { readDraft, validDraftContext } from "../content/drafts.ts";
import { followedTargets, parseFollowTargets } from "../follows/repository.ts";
import { validateDisplayName } from "../member/names.ts";
import {
  readMember,
  readNameHistory,
  resolveMemberLocale,
  saveMemberLocale,
  updateDisplayName,
} from "../member/store.ts";
import { unreadNotificationCount } from "../notifications/repository.ts";
import {
  acpPermissionsFor,
  DEFAULT_STAFF_SCHEME,
  isStaffScheme,
  type StaffScheme,
} from "../permissions/acp.ts";
import { listDismissedAnnouncementIds } from "../permissions/announcements.ts";
import { can } from "../permissions/can.ts";
import { loadPermissionSnapshot } from "../permissions/snapshot.ts";
import { loadForumTree } from "../permissions/tree-store.ts";
import { pollVoteStateForTopic } from "../polls/repository.ts";
import { readViewerReactions } from "../reactions/repository.ts";
import { ignoredMemberIds } from "../relationships/index.ts";
import { readViewerVotes } from "../reputation/repository.ts";
import {
  firstUnreadForTopics,
  readPostContext,
  readTopicForumIds,
  unreadForumIds,
  unreadTopicIds,
} from "../topics/reading/repository.ts";
import { canonicalUrl } from "../urls/index.ts";
import { memberViewerKey, parseTopicIds, parseVisitContext, recordVisit } from "../visits/index.ts";
import type { AuthRouterOptions, SessionCapabilities } from "./router.ts";
import { createAuthRouter, guestView, sessionView } from "./router.ts";
import { createSessionStore, type SessionRecord, type SessionStore } from "./session-store.ts";
import { issueSession } from "./store.ts";
import {
  clientIp,
  createCsrfToken,
  parseCookieHeader,
  REAUTH_GRACE_MS,
  SESSION_LIFETIMES,
  STEP_UP_WINDOW_MS,
  serializeCookie,
  sessionCookieName,
  userAgent,
  verifyCsrfToken,
} from "./tokens.ts";

/** The ADR 0018 exemptions, by exact method and path. Nothing else bypasses CSRF. */
const CSRF_EXEMPT = new Set([
  "POST /api/auth/challenge",
  "POST /api/auth/session",
  "POST /api/beacon",
  "POST /api/me/overlay",
  "POST /api/notifications/unsubscribe",
]);

export function isCsrfExempt(method: string, pathname: string): boolean {
  return CSRF_EXEMPT.has(`${method.toUpperCase()} ${pathname}`);
}

export interface AuthServiceOptions extends AuthRouterOptions {
  readonly cacheTtlMs?: number;
  readonly testEndpoints?: boolean;
  /** Staff-only audit hook, called in the same transaction as a locale preference write. */
  readonly onStaffLocaleChange?: (sql: SQL, change: StaffLocaleChange) => Promise<void>;
}

export interface StaffLocaleChange {
  readonly memberId: string;
  readonly before: string | null;
  readonly after: Locale;
}

export interface AuthRequestContext {
  readonly session: SessionRecord | null;
  readonly csrfToken: string | null;
}

export type AuthNext = (context: AuthRequestContext) => Promise<Response>;

export interface AuthService {
  /** Handles auth endpoints and (in development) the test-only session endpoints. */
  handle(request: Request, next?: AuthNext): Promise<Response | null>;
  close(): Promise<void>;
  readonly sessions: SessionStore;
}

function json(body: unknown, status = 200, cookies: readonly string[] = []): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });

  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }

  return new Response(JSON.stringify(body), { status, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();

  if (text.trim() === "") {
    return {};
  }

  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function withSetCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

interface StaffSessionContext extends SessionCapabilities {
  readonly scheme: StaffScheme;
}

/** ACP capabilities and the remembered colour mode for the staff session view. */
async function readStaffSessionContext(sql: SQL, memberId: string): Promise<StaffSessionContext> {
  const [preferences] = (await sql`
    SELECT staff_scheme
    FROM core.member_prefs
    WHERE member_id = ${memberId}
  `) as Array<{ staff_scheme: string }>;
  const scheme = isStaffScheme(preferences?.staff_scheme)
    ? preferences.staff_scheme
    : DEFAULT_STAFF_SCHEME;

  return { permissions: await acpPermissionsFor(sql, memberId), scheme };
}

/**
 * The complete auth service for one origin: login, session lookup/middleware, rotation,
 * silent re-auth and the test-only endpoints. `handle` returns `null` for paths the service
 * does not own so an app can keep its own routes.
 */
export async function createAuthService(options: AuthServiceOptions): Promise<AuthService> {
  const sessions = await createSessionStore({
    sql: options.sql,
    ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
  });
  const router = createAuthRouter({ ...options, sessions });
  const secure = options.nodeEnv === "production";
  const cookieName = sessionCookieName(options.kind, options.nodeEnv);
  const sessionMaxAge = Math.trunc(SESSION_LIFETIMES[options.kind].absoluteMs / 1_000);

  async function withSession(
    request: Request,
    next: AuthNext,
    hooks: { readonly onReauthRequired?: (session: SessionRecord) => Response } = {},
  ): Promise<Response> {
    const token = parseCookieHeader(request.headers.get("cookie"))[cookieName];
    const session = token === undefined ? null : await sessions.find(options.kind, token);

    if (session === null) {
      return next({ session: null, csrfToken: null });
    }

    if (options.kind === "staff" && !(await can(options.sql, session.memberId, "acp.access"))) {
      return json({ code: "forbidden" }, 403);
    }

    if (options.kind === "user" && Date.now() > session.reauthAt.getTime() + REAUTH_GRACE_MS) {
      return hooks.onReauthRequired?.(session) ?? json({ code: "reauth_required" }, 401);
    }

    await sessions.touch(session);
    const response = await next({
      session,
      csrfToken: createCsrfToken(session.id, options.sessionSecret),
    });

    if (!session.rotatePending) {
      return response;
    }

    const rotated = await sessions.rotate(session);

    if (rotated === null) {
      return response;
    }

    return withSetCookie(
      response,
      serializeCookie(cookieName, rotated.token, {
        maxAge: sessionMaxAge,
        secure,
        httpOnly: true,
      }),
    );
  }

  async function memberMe(request: Request): Promise<Response> {
    return withSession(request, async ({ session }) => {
      if (session === null) {
        return json({ code: "unauthenticated" }, 401);
      }

      const member = await readMember(options.sql, session.memberId);

      if (member === null) {
        return json({ code: "unauthenticated" }, 401);
      }

      if (member.displayName === null) {
        return json({ code: "display_name_required" }, 409);
      }

      return json({
        memberId: session.memberId,
        displayName: member.displayName,
        locale: member.locale,
      });
    });
  }

  async function setDisplayName(request: Request): Promise<Response> {
    return withSession(request, async ({ session }) => {
      if (session === null) {
        return json({ code: "unauthenticated" }, 401);
      }

      const body = await readJsonBody(request);

      if (body === null) {
        return json({ code: "invalid_request" }, 400);
      }

      const name = validateDisplayName(body.displayName);

      if (!name.ok) {
        return json({ code: name.code }, 400);
      }

      const result = await updateDisplayName(options.sql, session.memberId, name);

      if (result.kind === "missing") {
        return json({ code: "unauthenticated" }, 401);
      }

      if (result.kind === "taken") {
        return json({ code: "display_name_taken" }, 409);
      }

      if (result.kind === "limit") {
        return json(
          {
            code: "display_name_change_limit",
            nextAllowedAt: result.nextAllowedAt.toISOString(),
          },
          429,
        );
      }

      sessions.invalidate?.();
      return json({ displayName: result.displayName });
    });
  }

  async function saveLocale(request: Request): Promise<Response> {
    return withSession(request, async ({ session }) => {
      if (session === null) {
        return json({ code: "unauthenticated" }, 401);
      }

      const member = await readMember(options.sql, session.memberId);

      if (member === null) {
        return json({ code: "unauthenticated" }, 401);
      }

      if (member.displayName === null) {
        return json({ code: "display_name_required" }, 409);
      }

      const body = await readJsonBody(request);

      if (body === null) {
        return json({ code: "invalid_request" }, 400);
      }

      if (typeof body.locale !== "string" || !isLocale(body.locale)) {
        return json({ code: "invalid_locale" }, 400);
      }

      const nextLocale: Locale = body.locale;
      const hook = options.kind === "staff" ? options.onStaffLocaleChange : undefined;

      if (hook === undefined) {
        await saveMemberLocale(options.sql, session.memberId, nextLocale);
      } else {
        await options.sql.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtext(${`bulletin.staff_prefs:${session.memberId}`})::bigint)`;
          const current = await readMember(tx, session.memberId);
          await saveMemberLocale(tx, session.memberId, nextLocale);
          await hook(tx, {
            memberId: session.memberId,
            before: current?.locale ?? null,
            after: nextLocale,
          });
        });
      }

      return json({ locale: nextLocale });
    });
  }

  async function ownSessions(request: Request): Promise<Response> {
    return withSession(request, async ({ session }) => {
      if (session === null) {
        return json({ code: "unauthenticated" }, 401);
      }

      const token = parseCookieHeader(request.headers.get("cookie"))[cookieName];

      if (token === undefined) {
        return json({ code: "unauthenticated" }, 401);
      }

      // ADR 0012: the member's own sessions are only readable through this audited
      // definer function, which derives the actor from the session token.
      const rows = (await options.sql`
        SELECT session_id::text AS session_id,
               kind,
               is_current,
               created_at,
               last_seen_at,
               ip,
               browser_family
        FROM pii.list_own_sessions(${token})
      `) as Array<{
        session_id: string;
        kind: string;
        is_current: boolean;
        created_at: Date | string;
        last_seen_at: Date | string;
        ip: string | null;
        browser_family: string;
      }>;

      return json({
        sessions: rows.map((row) => ({
          id: row.session_id,
          kind: row.kind,
          current: row.is_current,
          createdAt: new Date(row.created_at).toISOString(),
          lastSeenAt: new Date(row.last_seen_at).toISOString(),
          ip: row.ip,
          browser: row.browser_family,
        })),
      });
    });
  }

  async function memberOverlay(request: Request): Promise<Response> {
    // ADR 0018: the bootstrap call is CSRF-exempt, so it requires this header (which forces a
    // preflight cross-site) in addition to the origin check `handle` already performed.
    if (request.headers.get("x-bulletin-overlay") !== "1") {
      return json({ code: "overlay_required" }, 403);
    }

    return withSession(request, async ({ session, csrfToken }) => {
      if (session === null) {
        return json({ code: "unauthenticated" }, 401);
      }

      const body = await readJsonBody(request);
      const ctx = body?.ctx;

      if (typeof ctx !== "string" || ctx.length > 64 || parseVisitContext(ctx) === null) {
        return json({ code: "invalid_context" }, 400);
      }

      const topics = parseTopicIds(body?.topics);
      const followTargets = parseFollowTargets(body?.followTargets);
      const draftContext = validDraftContext(body?.draftContext) ? body.draftContext : null;
      const lastReadAt =
        typeof body?.lastReadAt === "string" && !Number.isNaN(Date.parse(body.lastReadAt))
          ? new Date(body.lastReadAt)
          : undefined;
      const lastReadPostId =
        typeof body?.lastReadPostId === "string" && /^\d+$/.test(body.lastReadPostId)
          ? body.lastReadPostId
          : undefined;
      const visitContext = parseVisitContext(ctx);
      const requestedForums = parseTopicIds(body?.forums);
      const requestedPosts = parseTopicIds(body?.posts);
      const [tree, settings] = await Promise.all([
        loadForumTree(options.sql),
        readBoardSettings(options.sql),
      ]);
      const snapshot = await loadPermissionSnapshot(options.sql, session.memberId, {
        tree,
        sessionId: session.id,
      });
      const scope = { tree, sessionId: session.id, snapshot };
      const topicForums = await readTopicForumIds(options.sql, topics);
      const readableTopics: string[] = [];

      for (const topicId of topics) {
        const forumId = topicForums.get(topicId);

        if (
          forumId !== undefined &&
          (await can(options.sql, session.memberId, "read", {
            ...scope,
            forumId,
          }))
        ) {
          readableTopics.push(topicId);
        }
      }

      const readableForums: string[] = [];

      for (const forumId of requestedForums) {
        if (
          tree.get(forumId) !== undefined &&
          (await can(options.sql, session.memberId, "read", { ...scope, forumId }))
        ) {
          readableForums.push(forumId);
        }
      }

      if (visitContext?.kind === "topic") {
        const forumId = (await readTopicForumIds(options.sql, [visitContext.id])).get(
          visitContext.id,
        );

        if (
          forumId === undefined ||
          !(await can(options.sql, session.memberId, "read", { ...scope, forumId }))
        ) {
          return json({ code: "not_found" }, 404);
        }
      } else if (visitContext?.kind === "forum") {
        if (
          tree.get(visitContext.id) === undefined ||
          !(await can(options.sql, session.memberId, "read", {
            ...scope,
            forumId: visitContext.id,
          }))
        ) {
          return json({ code: "not_found" }, 404);
        }
      }

      const [visits, dismissedAnnouncements, draft, poll, signaturePrivacy] = await Promise.all([
        recordVisit(options.sql, {
          viewerKey: memberViewerKey(session.memberId),
          ctx,
          topics: readableTopics,
          memberId: session.memberId,
          ...(lastReadAt === undefined ? {} : { lastReadAt }),
          ...(lastReadPostId === undefined ? {} : { lastReadPostId }),
        }),
        listDismissedAnnouncementIds(options.sql, session.memberId),
        draftContext === null
          ? Promise.resolve(null)
          : readDraft(options.sql, session.memberId, draftContext),
        visitContext?.kind === "topic"
          ? pollVoteStateForTopic(options.sql, visitContext.id, session.memberId)
          : Promise.resolve(null),
        options.sql`
          SELECT hide_signatures FROM core.members WHERE id = ${session.memberId}
        `,
      ]);
      void visits;
      const [unreadIds, unreadForums, follows, ignored] = await Promise.all([
        unreadTopicIds(options.sql, {
          memberId: session.memberId,
          topicIds: readableTopics,
        }),
        unreadForumIds(options.sql, {
          memberId: session.memberId,
          forumIds: readableForums,
          sessionId: session.id,
          tree,
          snapshot,
        }),
        followedTargets(options.sql, session.memberId, followTargets),
        ignoredMemberIds(options.sql, session.memberId),
      ]);
      const followed = new Set(follows);
      const firstUnreadRows = (
        await Promise.all(
          readableTopics.map(async (topicId) => {
            const forumId = topicForums.get(topicId);

            if (forumId === undefined) {
              return [];
            }

            return firstUnreadForTopics(options.sql, {
              memberId: session.memberId,
              topicIds: [topicId],
              perPage: settings.postsPerPage,
              seeUnapproved: await can(options.sql, session.memberId, "see_unapproved", {
                ...scope,
                forumId,
              }),
              seeDeleted: await can(options.sql, session.memberId, "see_deleted", {
                ...scope,
                forumId,
              }),
            });
          }),
        )
      ).flat();
      const editWindow = Number(snapshot.settings["posting.edit_window_minutes"] ?? 0);
      const canDeleteOwn = snapshot.settings["posting.can_delete_own"] === true;
      const editablePosts: Array<Record<string, unknown>> = [];
      const reactionPosts: string[] = [];

      for (const postId of requestedPosts) {
        const post = await readPostContext(options.sql, postId);

        if (post === null || post.visibility !== "visible") {
          continue;
        }

        const postScope = { ...scope, forumId: post.forumId };

        if (!(await can(options.sql, session.memberId, "read", postScope))) {
          continue;
        }

        reactionPosts.push(post.id);

        const isAuthor = post.authorId === session.memberId;
        const moderatorEdit = await can(options.sql, session.memberId, "edit", postScope);
        const ageMinutes = (Date.now() - post.createdAt.getTime()) / 60_000;
        const withinWindow = editWindow <= 0 || ageMinutes <= editWindow;
        const canEdit = moderatorEdit || (isAuthor && withinWindow);
        const canDelete =
          (isAuthor && canDeleteOwn) ||
          (await can(options.sql, session.memberId, "soft_delete", postScope));
        const canViewHistory =
          (await can(options.sql, session.memberId, "view_edit_history", postScope)) ||
          settings.publicEditHistory;

        if (!canEdit && !canDelete && !canViewHistory) {
          continue;
        }

        editablePosts.push({
          postId: post.id,
          ...(canEdit ? { bodyMd: post.bodyMd } : {}),
          canEdit,
          canDelete,
          canRedact: moderatorEdit && !isAuthor,
          canViewHistory,
        });
      }

      const unreadSet = new Set(unreadIds);
      const viewerReactions = await readViewerReactions(
        options.sql,
        session.memberId,
        reactionPosts,
      );
      const viewerVotes = await readViewerVotes(options.sql, session.memberId, reactionPosts);
      const payload = {
        ctx,
        csrfToken: csrfToken ?? createCsrfToken(session.id, options.sessionSecret),
        unread: readableTopics.filter((topicId) => unreadSet.has(topicId)),
        unreadForums,
        follows: Object.fromEntries(followTargets.map((target) => [target, followed.has(target)])),
        firstUnread: firstUnreadRows.map((row) => ({
          topicId: row.topicId,
          // The permalink re-resolves the viewer's page after their own visibility ordering.
          url: canonicalUrl("topic", row.topicId, row.topicSlug, { postId: row.postId }),
        })),
        dismissedAnnouncements,
        counts: {
          notifications: await unreadNotificationCount(options.sql, session.memberId, {
            tree,
            snapshot,
          }),
          // Conversations arrive with the `conversations` change.
          conversations: 0,
        },
        polls: poll === null ? [] : [poll],
        hideSignatures: signaturePrivacy[0]?.hide_signatures === true,
        ignored,
        editablePosts,
        reactions: viewerReactions,
        reputation: viewerVotes,
        ...(draft === null ? {} : { draft }),
      };
      const text = JSON.stringify(payload);
      const etag = `"${new Bun.CryptoHasher("sha256").update(text).digest("hex")}"`;
      const headers = new Headers({
        "cache-control": "private, no-cache",
        "content-type": "application/json; charset=utf-8",
        etag,
      });

      if (request.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers });
      }

      return new Response(text, { status: 200, headers });
    });
  }

  async function nameHistory(request: Request, memberId: string): Promise<Response> {
    return withSession(request, async ({ session }) => {
      if (session === null) {
        return json({ code: "unauthenticated" }, 401);
      }

      if (!(await can(options.sql, session.memberId, "members.view_name_history"))) {
        return json({ code: "forbidden" }, 403);
      }

      const history = await readNameHistory(options.sql, memberId);

      return json({
        history: history.map((entry) => ({
          oldName: entry.oldName,
          newName: entry.newName,
          changedAt: entry.changedAt.toISOString(),
          changedBy: entry.changedBy,
        })),
      });
    });
  }

  function testEndpoint(request: Request, pathname: string): Promise<Response> | null {
    if (options.testEndpoints !== true) {
      return null;
    }

    if (pathname === "/api/test/protected") {
      if (request.method !== "GET" && request.method !== "POST") {
        return Promise.resolve(json({ code: "method_not_allowed" }, 405));
      }

      return withSession(request, async ({ session }) => {
        if (session === null) {
          return json({ code: "unauthenticated" }, 401);
        }

        return json({ ok: true, memberId: session.memberId, kind: session.kind });
      });
    }

    if (pathname === "/api/test/age-session") {
      if (request.method !== "POST") {
        return Promise.resolve(json({ code: "method_not_allowed" }, 405));
      }

      return withSession(request, async ({ session }) => {
        if (session === null) {
          return json({ code: "unauthenticated" }, 401);
        }

        await options.sql`
          UPDATE core.sessions
          SET last_auth_at = now() - interval '20 minutes'
          WHERE id = ${session.id}
        `;
        sessions.invalidate();

        return json({ ok: true });
      });
    }

    if (pathname === "/api/test/age-reauth") {
      if (options.kind !== "user") {
        return null;
      }

      if (request.method !== "POST") {
        return Promise.resolve(json({ code: "method_not_allowed" }, 405));
      }

      return withSession(request, async ({ session }) => {
        if (session === null) {
          return json({ code: "unauthenticated" }, 401);
        }

        await options.sql`
          UPDATE core.sessions
          SET reauth_at = now() - interval '25 hours'
          WHERE id = ${session.id}
        `;
        sessions.invalidate();
        await options.sql`SELECT pg_notify('session_revoked', ${session.id})`;

        return json({ ok: true });
      });
    }

    if (options.kind === "user" && pathname === "/api/test/session") {
      if (request.method !== "POST") {
        return Promise.resolve(json({ code: "method_not_allowed" }, 405));
      }

      // Test-only (development): mint a member session over HTTP so the latency benchmark
      // needs no browser. Identity mapping still goes through pii.resolve_identity.
      return (async () => {
        const body = await readJsonBody(request);
        const sub = body?.sub;

        if (typeof sub !== "string" || sub === "") {
          return json({ code: "invalid_request" }, 400);
        }

        const issued = await options.sql.begin(async (tx) => {
          const rows = (await tx`
            SELECT pii.resolve_identity(${options.issuer}, ${sub}, '', '') AS member_id
          `) as Array<{ member_id: string }>;
          const memberId = rows[0]?.member_id;

          if (memberId === undefined) {
            return null;
          }

          const session = await issueSession(tx, {
            kind: "user",
            memberId,
            ip: clientIp(request),
            userAgent: userAgent(request),
            authTime: new Date(),
          });

          return { memberId, token: session.token };
        });

        if (issued === null) {
          return json({ code: "not_found" }, 404);
        }

        return withSetCookie(
          json({ ok: true, memberId: issued.memberId }),
          serializeCookie(cookieName, issued.token, {
            maxAge: sessionMaxAge,
            secure,
            httpOnly: true,
          }),
        );
      })();
    }

    if (options.kind === "user" && pathname === "/api/test/reset-rate-buckets") {
      if (request.method !== "POST") {
        return Promise.resolve(json({ code: "method_not_allowed" }, 405));
      }

      // Test-only (development): clear the UNLOGGED flood-control buckets so re-runs start
      // from an empty window. The origin check in `handle` still applies.
      return Promise.resolve(
        options.sql`DELETE FROM core.rate_buckets`.then(() => json({ ok: true })),
      );
    }

    if (options.kind === "user" && pathname === "/api/test/reset-poll-votes") {
      if (request.method !== "POST") {
        return Promise.resolve(json({ code: "method_not_allowed" }, 405));
      }

      // Test-only (development): clear poll votes so the voting E2E can re-run.
      return Promise.resolve(
        options.sql.begin(async (tx) => {
          await tx`DELETE FROM core.poll_vote_choices`;
          await tx`DELETE FROM core.poll_votes`;
          return json({ ok: true });
        }),
      );
    }

    if (options.kind === "user" && pathname === "/api/test/reset-display-name") {
      if (request.method !== "POST") {
        return Promise.resolve(json({ code: "method_not_allowed" }, 405));
      }

      return withSession(request, async ({ session }) => {
        if (session === null) {
          return json({ code: "unauthenticated" }, 401);
        }

        // Test-only (development) support for the display-name step E2E to start clean.
        await options.sql`
          UPDATE core.members
          SET display_name = NULL, name_skeleton = NULL
          WHERE id = ${session.memberId}
        `;
        sessions.invalidate();

        return json({ ok: true });
      });
    }

    if (options.kind === "staff" && pathname === "/api/test/sensitive") {
      if (request.method !== "GET" && request.method !== "POST") {
        return Promise.resolve(json({ code: "method_not_allowed" }, 405));
      }

      return withSession(request, async ({ session }) => {
        if (session === null) {
          return json({ code: "unauthenticated" }, 401);
        }

        if (Date.now() - session.lastAuthAt.getTime() > STEP_UP_WINDOW_MS) {
          return json({ code: "step_up_required" }, 401);
        }

        return json({ ok: true });
      });
    }

    return null;
  }

  async function handleStaffRevoke(request: Request, memberId: string): Promise<Response> {
    if (request.method !== "POST") {
      return json({ code: "method_not_allowed" }, 405);
    }

    return withSession(request, async ({ session }) => {
      if (session === null) {
        return json({ code: "unauthenticated" }, 401);
      }

      if (!(await can(options.sql, session.memberId, "sessions.revoke"))) {
        return json({ code: "forbidden" }, 403);
      }

      const revoked = await sessions.revokeMemberSessions(memberId);
      return json({ revoked });
    });
  }

  return {
    sessions,
    async handle(request, next) {
      const { pathname } = new URL(request.url);

      if (request.method !== "GET" && request.method !== "HEAD") {
        if (request.headers.get("origin") !== options.origin) {
          return json({ code: "invalid_origin" }, 403);
        }

        const devTestPost =
          options.testEndpoints === true &&
          options.kind === "user" &&
          (pathname === "/api/test/session" ||
            pathname === "/api/test/reset-rate-buckets" ||
            pathname === "/api/test/reset-poll-votes");

        if (!isCsrfExempt(request.method, pathname) && !devTestPost) {
          const token = parseCookieHeader(request.headers.get("cookie"))[cookieName];
          const session = token === undefined ? null : await sessions.find(options.kind, token);

          if (session === null) {
            return json({ code: "unauthenticated" }, 401);
          }

          if (
            !verifyCsrfToken(
              request.headers.get("x-bulletin-csrf"),
              createCsrfToken(session.id, options.sessionSecret),
            )
          ) {
            return json({ code: "invalid_csrf" }, 403);
          }
        }
      }

      if (pathname === "/api/auth/session" && request.method === "GET") {
        return withSession(
          request,
          async ({ session }) => {
            if (session === null) {
              return json(guestView(options.kind));
            }

            const locale = await resolveMemberLocale(options.sql, session.memberId);
            const capabilities =
              options.kind === "staff"
                ? await readStaffSessionContext(options.sql, session.memberId)
                : {};
            return json(sessionView(options, session, locale, capabilities));
          },
          {
            onReauthRequired: (session) =>
              json(
                {
                  code: "reauth_required",
                  csrfToken: createCsrfToken(session.id, options.sessionSecret),
                  memberId: session.memberId,
                  kind: options.kind,
                },
                401,
              ),
          },
        );
      }

      const authResponse = await router(request);

      if (authResponse !== null) {
        return authResponse;
      }

      if (pathname === "/api/me") {
        if (request.method !== "GET") {
          return json({ code: "method_not_allowed" }, 405);
        }

        return memberMe(request);
      }

      if (pathname === "/api/me/display-name") {
        if (request.method !== "POST") {
          return json({ code: "method_not_allowed" }, 405);
        }

        return setDisplayName(request);
      }

      if (pathname === "/api/me/locale") {
        if (request.method !== "POST") {
          return json({ code: "method_not_allowed" }, 405);
        }

        return saveLocale(request);
      }

      if (pathname === "/api/me/sessions") {
        if (request.method !== "GET") {
          return json({ code: "method_not_allowed" }, 405);
        }

        return ownSessions(request);
      }

      if (pathname === "/api/me/overlay") {
        if (request.method !== "POST") {
          return json({ code: "method_not_allowed" }, 405);
        }

        return memberOverlay(request);
      }

      if (options.kind === "staff") {
        const historyMatch = /^\/api\/staff\/members\/(\d+)\/name-history$/.exec(pathname);

        if (historyMatch !== null) {
          if (request.method !== "GET") {
            return json({ code: "method_not_allowed" }, 405);
          }

          return nameHistory(request, historyMatch[1] ?? "");
        }
      }

      if (options.kind === "staff") {
        const match = /^\/api\/staff\/members\/(\d+)\/sessions\/revoke$/.exec(pathname);

        if (match !== null) {
          return handleStaffRevoke(request, match[1] ?? "");
        }
      }

      const testResponse = testEndpoint(request, pathname);

      if (testResponse !== null) {
        return testResponse;
      }

      return next === undefined ? null : withSession(request, next);
    },
    async close() {
      await sessions.close();
    },
  };
}
