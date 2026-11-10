import type { SQL } from "bun";
import {
  CACHE_TAG_NOTIFY_CHANNEL,
  GLOBAL_CACHE_TAGS,
  readTagVersion,
  readTagVersions,
  type TagVersionSource,
} from "./tags.ts";

/** Each process echoes a heartbeat over this interval (ADR 0006). */
export const CACHE_HEARTBEAT_MS = 2_000;

/** A heartbeat later than this marks the versions untrusted (ADR 0006). */
export const CACHE_HEARTBEAT_TIMEOUT_MS = 5_000;

/** The `perm` tag is re-read at most once per second, independent of NOTIFY (ADR 0006). */
export const PERM_BACKSTOP_MS = 1_000;

export interface TagVersionsOptions {
  readonly sql: SQL;
  /** Heartbeat interval; tests shorten it; production keeps the 2 s from ADR 0006. */
  readonly heartbeatMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly permBackstopMs?: number;
  readonly now?: () => number;
  /** Unique per process so other processes never see this process's heartbeats. */
  readonly healthChannel?: string;
  readonly tagChannel?: string;
  readonly permTag?: string;
}

export interface TagVersions extends TagVersionSource {
  /** Reloads every durable tag version (LISTEN first, then this load). */
  refresh(): Promise<void>;
  /** The 1 s backstop: re-reads `perm` when the interval elapsed. */
  ensurePermFresh(): Promise<void>;
  readonly versions: ReadonlyMap<string, string>;
  /** True while the LISTEN connection has been re-established and a version load succeeded. */
  isConnected(): boolean;
  /** Test and operations seam for a listener drop. */
  markDown(): void;
  close(): Promise<void>;
}

/**
 * The in-process tag-version store (ADR 0006). It LISTENs before loading versions, echoes a
 * heartbeat that only its own listener connection can receive, and marks itself untrusted when
 * the heartbeat is late or the connection drops. While untrusted the render cache bypasses the
 * in-process LRU and reads Postgres instead (fail closed).
 */
export async function createTagVersions(options: TagVersionsOptions): Promise<TagVersions> {
  const now = options.now ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? CACHE_HEARTBEAT_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? CACHE_HEARTBEAT_TIMEOUT_MS;
  const permBackstopMs = options.permBackstopMs ?? PERM_BACKSTOP_MS;
  const tagChannel = options.tagChannel ?? CACHE_TAG_NOTIFY_CHANNEL;
  const permTag = options.permTag ?? GLOBAL_CACHE_TAGS.perm;
  const healthChannel =
    options.healthChannel ?? `bulletin_cache_health_${crypto.randomUUID().slice(0, 8)}`;

  const versions = new Map<string, string>();
  let connected = false;
  let closed = false;
  let lastSignalAt = Number.NEGATIVE_INFINITY;
  let lastPermCheckAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;

  async function readAll(): Promise<void> {
    const next = await readTagVersions(options.sql);
    versions.clear();

    for (const [tag, version] of next) {
      versions.set(tag, version);
    }

    lastPermCheckAt = now();
  }

  /** Coalesces concurrent reloads; a rejected load clears the slot for the next attempt. */
  function reload(): Promise<void> {
    inflight ??= readAll().finally(() => {
      inflight = null;
    });

    return inflight;
  }

  function markDown(): void {
    connected = false;
  }

  function markSignal(): void {
    lastSignalAt = now();
  }

  async function connect(): Promise<void> {
    try {
      await reload();
      connected = true;
      markSignal();
    } catch {
      markDown();
    }
  }

  const onlisten = (): void => {
    // LISTEN is acknowledged (initially and after every reconnect), so load versions again:
    // notifications sent while the connection was down were lost.
    markSignal();
    void connect();
  };
  const onnotify = (): void => {
    markSignal();
    void reload().catch(markDown);
  };

  const tagSubscription = await options.sql.listen(tagChannel, onnotify, onlisten);
  const healthSubscription = await options.sql.listen(healthChannel, markSignal, onlisten);

  // The explicit initial load also covers a connection whose onlisten callback already ran.
  await connect();

  const heartbeat = setInterval(() => {
    if (closed) {
      return;
    }

    void options.sql.notify(healthChannel, "1").catch(markDown);
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    version(tag) {
      return versions.get(tag) ?? "0";
    },

    isTrusted() {
      return !closed && connected && now() - lastSignalAt <= heartbeatTimeoutMs;
    },

    isConnected() {
      return connected;
    },

    markDown,

    async refresh() {
      await reload();
      connected = true;
      markSignal();
    },

    async ensurePermFresh() {
      const timestamp = now();

      if (timestamp - lastPermCheckAt < permBackstopMs) {
        return;
      }

      versions.set(permTag, await readTagVersion(options.sql, permTag));
      lastPermCheckAt = timestamp;
    },

    get versions() {
      return versions;
    },

    async close() {
      if (closed) {
        return;
      }

      closed = true;
      connected = false;
      clearInterval(heartbeat);
      await Promise.all([tagSubscription.unlisten(), healthSubscription.unlisten()]);
    },
  };
}
