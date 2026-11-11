import type { SQL } from "bun";

export type Unsubscribe = () => void;

/**
 * One LISTEN connection per user-api process, fanned out to every open stream (ADR 0003: a
 * single dedicated direct connection). Streams register callbacks and re-read durable state.
 */
export interface StreamHub {
  /** Calls back when a notification was created for this member. */
  onMember(memberId: string, callback: () => void): Unsubscribe;
  /** Calls back when a post was created in this topic. */
  onTopic(topicId: string, callback: () => void): Unsubscribe;
  /** Calls back with the revoked session's member id or session id. */
  onSessionRevoked(callback: (payload: string) => void): Unsubscribe;
  close(): Promise<void>;
}

function listen<T>(map: Map<string, Set<T>>, key: string, callback: T): Unsubscribe {
  const listeners = map.get(key) ?? new Set<T>();
  listeners.add(callback);
  map.set(key, listeners);

  return () => {
    listeners.delete(callback);

    if (listeners.size === 0) {
      map.delete(key);
    }
  };
}

export async function createStreamHub(sql: SQL): Promise<StreamHub> {
  const members = new Map<string, Set<() => void>>();
  const topics = new Map<string, Set<() => void>>();
  const sessionRevoked = new Set<(payload: string) => void>();

  const memberSubscription = await sql.listen("notify_member", (payload) => {
    for (const callback of members.get(payload) ?? []) {
      callback();
    }
  });
  const topicSubscription = await sql.listen("topic_activity", (payload) => {
    for (const callback of topics.get(payload) ?? []) {
      callback();
    }
  });
  const sessionSubscription = await sql.listen("session_revoked", (payload) => {
    for (const callback of sessionRevoked) {
      callback(payload);
    }
  });

  return {
    onMember(memberId, callback) {
      return listen(members, memberId, callback);
    },
    onTopic(topicId, callback) {
      return listen(topics, topicId, callback);
    },
    onSessionRevoked(callback) {
      sessionRevoked.add(callback);
      return () => {
        sessionRevoked.delete(callback);
      };
    },
    async close() {
      members.clear();
      topics.clear();
      sessionRevoked.clear();
      await memberSubscription.unlisten();
      await topicSubscription.unlisten();
      await sessionSubscription.unlisten();
    },
  };
}
