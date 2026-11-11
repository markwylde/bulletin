/**
 * The versioned realtime contract shared by user-api and the browser client (ADR 0011). It has
 * no server-only imports so the client can use this subpath directly.
 */

/** Fixed control names. Clients must handle all three (realtime-stream spec). */
export const STREAM_CONTROL_EVENTS = ["resync", "session_revoked", "reauth_required"] as const;

export type StreamControlEvent = (typeof STREAM_CONTROL_EVENTS)[number];

export const STREAM_EVENT_NAMES = {
  notifications: "notifications",
  newReplies: "new_replies",
  conversationReplies: "conversation_replies",
} as const;

export type StreamEventName = (typeof STREAM_EVENT_NAMES)[keyof typeof STREAM_EVENT_NAMES];

/** Background requests and streams keep working for 2 h after `reauth_at` (ADR 0018). */
export const STREAM_REAUTH_GRACE_MS = 2 * 60 * 60 * 1_000;

export interface StreamCursor {
  readonly notificationId: bigint | null;
  readonly postId: bigint | null;
  /** Present only on a conversation stream. */
  readonly messageId?: bigint | null;
}

const CURSOR = /^n:(\d+)\|t:(\d+)(?:\|m:(\d+))?$/;

/** `n:<notificationId>|t:<postId>[|m:<messageId>]`, the composite stream cursor. */
export function encodeStreamCursor(cursor: StreamCursor): string {
  const base = `n:${cursor.notificationId ?? 0n}|t:${cursor.postId ?? 0n}`;
  return cursor.messageId === undefined || cursor.messageId === null
    ? base
    : `${base}|m:${cursor.messageId}`;
}

export function parseStreamCursor(value: string | null | undefined): StreamCursor | null {
  if (value === null || value === undefined) {
    return null;
  }

  const match = CURSOR.exec(value.trim());

  if (match === null) {
    return null;
  }

  try {
    return {
      notificationId: BigInt(match[1] ?? "0"),
      postId: BigInt(match[2] ?? "0"),
      ...(match[3] === undefined ? {} : { messageId: BigInt(match[3]) }),
    };
  } catch {
    return null;
  }
}

/** A notification count update, or a "new replies in the open topic" banner update. */
export interface StreamNotificationPayload {
  readonly count: number;
}

export interface StreamNewRepliesPayload {
  readonly topicId: string;
  readonly count: number;
  readonly postId: string;
}

export interface StreamConversationRepliesPayload {
  readonly conversationId: string;
  readonly count: number;
  readonly messageId: string;
}
