import type { SQL } from "bun";
import { recordCacheUntrusted } from "./render-metrics.ts";
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
  /**
   * The dedicated direct connection for LISTEN (ADR 0003): never a transaction-mode pooler.
   * Defaults to `sql` when the deployment does not set `LISTEN_DATABASE_URL`.
   */
  readonly listenSql?: SQL;
  /** Heartbeat interval; tests shorten it; production keeps the 2 s from ADR 0006. */
  readonly heartbeatMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly permBackstopMs?: number;
  readonly now?: () => number;
  /** Unique per process so other processes never see this process's heartbeats. */
  readonly healthChannel?: string;
  readonly tagChannel?: string;
  readonly permTag?: string;
  /** Test seam for the durable version read; defaults to `readTagVersions`. */
  readonly readVersions?: () => Promise<ReadonlyMap<string, string>>;
  /** Test seam: observes each requested reload (a NOTIFY, a connect or an explicit refresh). */
  readonly onReloadRequested?: () => void;
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
  let requestedReloads = 0;
  let appliedReloads = 0;
  let running: Promise<void> | null = null;
  const readVersions = options.readVersions ?? (() => readTagVersions(options.sql));

  async function readAll(): Promise<void> {
    const next = await readVersions();
    versions.clear();

    for (const [tag, version] of next) {
      versions.set(tag, version);
    }

    lastPermCheckAt = now();
  }

  /**
   * The reload loop (ADR 0006). A read that started when a NOTIFY arrived can still be looking
   * at a snapshot older than the mutation that NOTIFY announced, so a read in flight is never
   * allowed to answer a later notification: every request received while it runs triggers one
   * more read. `running` is cleared in the loop's final synchronous step, and a request that
   * arrives after the clear starts a fresh run rather than being coalesced away. A failed read
   * ends the loop and leaves the listener untrusted (fail closed); the next successful connect
   * reloads everything.
   */
  function reload(): Promise<void> {
    requestedReloads += 1;
    options.onReloadRequested?.();

    if (running === null) {
      running = (async () => {
        try {
          for (;;) {
            const target = requestedReloads;
            await readAll();
            appliedReloads = target;

            if (appliedReloads >= requestedReloads) {
              return;
            }
          }
        } finally {
          running = null;
        }
      })();
    }

    return running;
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

  const listenSql = options.listenSql ?? options.sql;
  const tagSubscription = await listenSql.listen(tagChannel, onnotify, onlisten);
  const healthSubscription = await listenSql.listen(healthChannel, markSignal, onlisten);

  // The explicit initial load also covers a connection whose onlisten callback already ran.
  await connect();

  const heartbeat = setInterval(() => {
    if (closed) {
      return;
    }

    // ADR 0020: untrusted time is exported, since every second of it bypasses the LRU.
    if (!connected || now() - lastSignalAt > heartbeatTimeoutMs) {
      recordCacheUntrusted(heartbeatMs / 1_000);
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
