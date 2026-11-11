import type { SessionRecord } from "@bulletin/domain/auth";
import {
  maxConversationMessageId,
  readParticipation,
  visibleConversationMessageIdsAfter,
} from "@bulletin/domain/conversations";
import {
  encodeStreamCursor,
  parseStreamCursor,
  STREAM_CONTROL_EVENTS,
  STREAM_EVENT_NAMES,
  STREAM_REAUTH_GRACE_MS,
  type StreamCursor,
} from "@bulletin/domain/events/stream";
import {
  maxNotificationId,
  notificationReplayGap,
  unreadNotificationCount,
} from "@bulletin/domain/notifications";
import { can, loadForumTree } from "@bulletin/domain/permissions";
import { postReplayGap, readTopic, visiblePostIdsAfter } from "@bulletin/domain/topics";
import type { SQL } from "bun";
import type { StreamHub } from "./stream-hub.ts";

const DEFAULT_HEARTBEAT_MS = 25_000;
const DEFAULT_REVALIDATE_MS = 60_000;
const DEFAULT_RECONCILE_MS = 5_000;
const DEFAULT_REPLAY_LIMIT = 200;
const DEFAULT_REPLAY_WINDOW_MS = 60 * 60 * 1_000;
const ID = /^[1-9]\d{0,18}$/;

export interface StreamOptions {
  readonly sql: SQL;
  readonly session: SessionRecord;
  readonly request: Request;
  /** Test seams. */
  readonly heartbeatMs?: number;
  readonly revalidateMs?: number;
  readonly replayLimit?: number;
  readonly replayWindowMs?: number;
  readonly reconcileMs?: number;
  readonly now?: () => Date;
  /** The process-wide LISTEN hub; without it the stream subscribes directly (tests). */
  readonly hub?: StreamHub;
}

interface TopicScope {
  readonly id: string;
  readonly forumId: string;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function idParam(value: string | null): string | null {
  return value !== null && ID.test(value) ? value : null;
}

/**
 * `GET /api/stream`: the member SSE stream (ADR 0011, ADR 0003, ADR 0018). NOTIFY only wakes
 * it; every event is read from durable state and filtered by `can()`. It validates the session
 * at connect and every minute, sends a heartbeat and closes with a control event when the
 * session is revoked or its background re-auth grace expires.
 */
export async function streamResponse(options: StreamOptions): Promise<Response> {
  const { sql, session } = options;
  const url = new URL(options.request.url);
  const now = options.now ?? (() => new Date());
  const replayLimit = options.replayLimit ?? DEFAULT_REPLAY_LIMIT;
  const replayWindowMs = options.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
  const topicId = idParam(url.searchParams.get("topic"));
  const initialPostId = idParam(url.searchParams.get("post"));
  const conversationId = idParam(url.searchParams.get("conversation"));
  const initialMessageId = idParam(url.searchParams.get("message"));
  let scope: TopicScope | null = null;
  let conversationScope: string | null = null;

  const sessionState = async (): Promise<"ok" | "revoked" | "reauth"> => {
    const [row] = (await sql`
      SELECT revoked_at, reauth_at FROM core.sessions WHERE id = ${session.id}
    `) as Array<{ revoked_at: Date | string | null; reauth_at: Date | string }>;

    if (row === undefined || row.revoked_at !== null) {
      return "revoked";
    }

    const reauthAt = new Date(row.reauth_at).getTime();
    return now().getTime() > reauthAt + STREAM_REAUTH_GRACE_MS ? "reauth" : "ok";
  };

  const connectState = await sessionState();

  if (connectState !== "ok") {
    return json({ code: connectState === "revoked" ? "session_revoked" : "reauth_required" }, 401);
  }

  if (topicId !== null) {
    const topic = await readTopic(sql, topicId);
    scope = topic === null ? null : { id: topic.id, forumId: topic.forumId };

    if (
      scope === null ||
      !(await can(sql, session.memberId, "read", {
        forumId: scope.forumId,
        tree: await loadForumTree(sql),
        sessionId: session.id,
      }))
    ) {
      return json({ code: "not_found" }, 404);
    }
  }

  if (conversationId !== null) {
    if (
      topicId !== null ||
      (await readParticipation(sql, conversationId, session.memberId)) === null
    ) {
      return json({ code: "not_found" }, 404);
    }

    conversationScope = conversationId;
  }

  const restored = parseStreamCursor(options.request.headers.get("last-event-id"));
  let cursor: StreamCursor = restored ?? {
    notificationId: 0n,
    postId: initialPostId === null ? 0n : BigInt(initialPostId),
    ...(conversationScope !== null && initialMessageId !== null
      ? { messageId: BigInt(initialMessageId) }
      : {}),
  };

  if (conversationScope !== null && restored === null && initialMessageId === null) {
    // No cursor means "start now": existing history is already on the page.
    cursor = { ...cursor, messageId: await maxConversationMessageId(sql, conversationScope) };
  }
  const encoder = new TextEncoder();
  let closed = false;
  let reading = false;
  let pending = false;
  let lastCount = -1;

  let closeStream: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let revalidate: ReturnType<typeof setInterval> | undefined;
      let reconcile: ReturnType<typeof setInterval> | undefined;
      const unsubscribers: Array<() => void> = [];

      const send = (event: string, data: unknown): void => {
        if (closed) {
          return;
        }

        try {
          controller.enqueue(
            encoder.encode(
              `id: ${encodeStreamCursor(cursor)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        } catch {
          close();
        }
      };

      const close = (): void => {
        if (closed) {
          return;
        }

        closed = true;

        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
        }

        if (revalidate !== undefined) {
          clearInterval(revalidate);
        }

        if (reconcile !== undefined) {
          clearInterval(reconcile);
        }

        for (const unsubscribe of unsubscribers) {
          unsubscribe();
        }

        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };

      // Re-read the topic for every delivery: a move into a hidden forum must revoke the
      // subscription immediately, not only at connect time.
      const mayReadScope = async (): Promise<boolean> => {
        if (scope === null) {
          return false;
        }

        const current = await readTopic(sql, scope.id);

        if (current === null) {
          return false;
        }

        return can(sql, session.memberId, "read", {
          forumId: current.forumId,
          tree: await loadForumTree(sql),
          sessionId: session.id,
        });
      };

      const readNotifications = async (): Promise<void> => {
        const [count, latest] = await Promise.all([
          unreadNotificationCount(sql, session.memberId),
          maxNotificationId(sql, session.memberId),
        ]);

        if (count !== lastCount || latest !== cursor.notificationId) {
          lastCount = count;
          cursor = { ...cursor, notificationId: latest };
          send(STREAM_EVENT_NAMES.notifications, { count });
        }
      };

      const readReplies = async (): Promise<void> => {
        if (scope === null || !(await mayReadScope())) {
          return;
        }

        const rows = await visiblePostIdsAfter(sql, scope.id, cursor.postId ?? 0n, replayLimit + 1);

        if (rows.length === 0) {
          return;
        }

        // A move can land between the first check and the read; never emit a hidden topic's posts.
        if (!(await mayReadScope())) {
          return;
        }

        const latest = rows[rows.length - 1] ?? "0";
        cursor = { ...cursor, postId: BigInt(latest) };
        send(STREAM_EVENT_NAMES.newReplies, {
          topicId: scope.id,
          count: rows.length,
          postId: latest,
        });
      };

      const readConversationReplies = async (): Promise<void> => {
        if (conversationScope === null) {
          return;
        }

        if ((await readParticipation(sql, conversationScope, session.memberId)) === null) {
          return;
        }

        const rows = await visibleConversationMessageIdsAfter(
          sql,
          conversationScope,
          session.memberId,
          cursor.messageId ?? 0n,
          replayLimit + 1,
        );

        if (rows.length === 0) {
          return;
        }

        // Re-check participation after the read: removal must not leak a pending message.
        if ((await readParticipation(sql, conversationScope, session.memberId)) === null) {
          return;
        }

        const latest = rows[rows.length - 1] ?? "0";
        cursor = { ...cursor, messageId: BigInt(latest) };
        send(STREAM_EVENT_NAMES.conversationReplies, {
          conversationId: conversationScope,
          count: rows.length,
          messageId: latest,
        });
      };

      const gapTooLarge = async (from: StreamCursor): Promise<boolean> => {
        const stale = async (missed: number, oldest: Date | string | null): Promise<boolean> =>
          missed > replayLimit ||
          (oldest !== null && new Date(oldest).getTime() < now().getTime() - replayWindowMs);

        if (from.notificationId !== null && from.notificationId > 0n) {
          const gap = await notificationReplayGap(sql, session.memberId, from.notificationId);

          if (await stale(gap.missed, gap.oldest)) {
            return true;
          }
        }

        if (scope !== null && from.postId !== null && from.postId > 0n) {
          const gap = await postReplayGap(sql, scope.id, from.postId);

          if (await stale(gap.missed, gap.oldest)) {
            return true;
          }
        }

        return false;
      };

      const replay = async (): Promise<void> => {
        if (restored !== null && (await gapTooLarge(restored))) {
          send(STREAM_CONTROL_EVENTS[0], {});
        }

        await readNotifications();

        // Catch up replies after the page's last rendered post too: a reply that landed
        // between the page render and this connection (or a dropped NOTIFY) must still banner.
        if (scope !== null && (restored !== null || initialPostId !== null)) {
          await readReplies();
        }

        if (conversationScope !== null && (restored !== null || initialMessageId !== null)) {
          await readConversationReplies();
        }
      };

      const checkSession = async (): Promise<void> => {
        const state = await sessionState();

        if (state === "revoked") {
          send(STREAM_CONTROL_EVENTS[1], {});
          close();
          return;
        }

        if (state === "reauth") {
          send(STREAM_CONTROL_EVENTS[2], {});
          close();
          return;
        }

        await readNotifications();
      };

      const schedule = (): void => {
        if (closed) {
          return;
        }

        if (reading) {
          pending = true;
          return;
        }

        reading = true;

        void (async () => {
          try {
            do {
              pending = false;
              await readNotifications();
              await readReplies();
              await readConversationReplies();
            } while (pending && !closed);
          } catch {
            // The next wake-up or the revalidation retries a transient read error.
          } finally {
            reading = false;
          }
        })();
      };

      closeStream = close;

      if (options.hub !== undefined) {
        unsubscribers.push(
          options.hub.onMember(session.memberId, schedule),
          options.hub.onTopic(scope?.id ?? "", schedule),
          options.hub.onConversation(conversationScope ?? "", schedule),
          options.hub.onSessionRevoked((payload) => {
            if (payload === session.id || payload === session.memberId) {
              void checkSession().catch(close);
            }
          }),
        );
      } else {
        const notifyMember = await sql.listen("notify_member", (payload) => {
          if (payload === session.memberId) {
            schedule();
          }
        });
        const topicActivity = await sql.listen("topic_activity", (payload) => {
          if (scope !== null && payload === scope.id) {
            schedule();
          }
        });
        const conversationActivity = await sql.listen("conversation_activity", (payload) => {
          if (conversationScope !== null && payload === conversationScope) {
            schedule();
          }
        });
        const sessionRevoked = await sql.listen("session_revoked", (payload) => {
          if (payload === session.id || payload === session.memberId) {
            void checkSession().catch(close);
          }
        });
        unsubscribers.push(
          () => void notifyMember.unlisten(),
          () => void topicActivity.unlisten(),
          () => void conversationActivity.unlisten(),
          () => void sessionRevoked.unlisten(),
        );
      }

      heartbeat = setInterval(() => {
        if (closed) {
          return;
        }

        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          close();
        }
      }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
      revalidate = setInterval(() => {
        if (!closed) {
          void checkSession().catch(close);
        }
      }, options.revalidateMs ?? DEFAULT_REVALIDATE_MS);
      // The five-second backstop for missed NOTIFYs (counts and new-reply wakes).
      reconcile = setInterval(() => {
        if (!closed) {
          schedule();
        }
      }, options.reconcileMs ?? DEFAULT_RECONCILE_MS);

      options.request.signal.addEventListener("abort", close);

      await replay();
      await checkSession();
    },
    cancel() {
      closeStream?.();
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}
