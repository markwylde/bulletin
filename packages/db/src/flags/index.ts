import { CACHE_TAG_NOTIFY_CHANNEL } from "@bulletin/cache";
import {
  assertFlagDefinitions,
  FLAG_CACHE_TAG,
  FLAG_HEARTBEAT_MS,
  type FlagDefinition,
  type FlagDefinitionSource,
  type FlagRuntime,
  type FlagViewer,
  GUEST_VIEWER,
  parseFlagRules,
} from "@bulletin/flags";
import type { SQL } from "bun";

/** A stored flag: the evaluated definition plus the timestamps the staff app shows. */
export interface StoredFlag extends FlagDefinition {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface FlagRow {
  key: string;
  description: string;
  owner: string;
  default_value: boolean;
  affects_render: boolean;
  client_visible: boolean;
  rules: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toStoredFlag(row: FlagRow): StoredFlag {
  return {
    key: row.key,
    description: row.description,
    owner: row.owner,
    defaultValue: row.default_value,
    affectsRender: row.affects_render,
    clientVisible: row.client_visible,
    rules: parseFlagRules(row.rules),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

export async function readFlagVersion(sql: SQL): Promise<string> {
  const rows = (await sql`
    SELECT version::text AS version
    FROM core.cache_tags
    WHERE tag = ${FLAG_CACHE_TAG}
  `) as Array<{ version: string }>;

  return rows[0]?.version ?? "0";
}

export async function loadStoredFlags(sql: SQL): Promise<StoredFlag[]> {
  const rows = (await sql`
    SELECT key, description, owner, default_value, affects_render, client_visible,
           rules, created_at, updated_at
    FROM core.feature_flags
    ORDER BY key
  `) as FlagRow[];

  return rows.map(toStoredFlag);
}

/** Bumps the `flags` tag in the caller's transaction and wakes every process (ADR 0006). */
export async function bumpFlagTag(sql: SQL): Promise<void> {
  await sql`
    INSERT INTO core.cache_tags (tag, version)
    VALUES (${FLAG_CACHE_TAG}, 1)
    ON CONFLICT (tag) DO UPDATE
    SET version = core.cache_tags.version + 1, updated_at = now()
  `;
  await sql`SELECT pg_notify(${CACHE_TAG_NOTIFY_CHANNEL}, ${FLAG_CACHE_TAG})`;
}

/**
 * Inserts code-declared flags that have no stored definition, with their code default and no
 * rules. Existing rows keep their staff-configured rules and default. Returns the new keys.
 */
export async function syncFlagDefinitions(
  sql: SQL,
  definitions: readonly FlagDefinition[],
): Promise<string[]> {
  assertFlagDefinitions(definitions);
  const inserted: string[] = [];

  await sql.begin(async (tx) => {
    for (const definition of definitions) {
      const rows = (await tx`
        INSERT INTO core.feature_flags (
          key, description, owner, default_value, affects_render, client_visible, rules
        )
        VALUES (
          ${definition.key}, ${definition.description}, ${definition.owner},
          ${definition.defaultValue}, ${definition.affectsRender}, ${definition.clientVisible},
          ${definition.rules}::jsonb
        )
        ON CONFLICT (key) DO NOTHING
        RETURNING key
      `) as Array<{ key: string }>;

      for (const row of rows) {
        inserted.push(row.key);
      }
    }

    if (inserted.length > 0) {
      await bumpFlagTag(tx);
    }
  });

  return inserted;
}

export function createFlagDefinitionSource(sql: SQL): FlagDefinitionSource {
  return {
    version: () => readFlagVersion(sql),
    load: () => loadStoredFlags(sql),
  };
}

/** The heartbeat channel for this process's flags listener (ADR 0006). */
export const FLAG_LISTENER_HEALTH_CHANNEL = "flags_cache_health";

export interface FlagWatchOptions {
  /** Heartbeat interval; tests shorten it, production keeps the 2 s from ADR 0006. */
  readonly heartbeatMs?: number;
}

export interface FlagWatch {
  close(): Promise<void>;
}

/**
 * Watches the cache tag channel and keeps the runtime's listener health current. ADR 0006:
 * LISTEN first, then reload versions; echo a heartbeat every 2 s; a missing echo or a dropped
 * connection marks the snapshot untrusted until the listener reconnects.
 */
export async function watchFlagInvalidation(
  sql: SQL,
  runtime: FlagRuntime,
  options: FlagWatchOptions = {},
): Promise<FlagWatch> {
  const heartbeatMs = options.heartbeatMs ?? FLAG_HEARTBEAT_MS;

  // The on-connect callback also runs after a reconnect. Invalidating first closes the
  // LISTEN-before-version-read race: the next request reloads the durable tag version.
  const subscription = await sql.listen(
    CACHE_TAG_NOTIFY_CHANNEL,
    (payload) => {
      if (payload === FLAG_CACHE_TAG) {
        runtime.invalidate();
      }

      runtime.setListenerHealthy(true);
    },
    () => {
      runtime.invalidate();
      runtime.setListenerHealthy(true);
    },
  );
  const health = await sql.listen(
    FLAG_LISTENER_HEALTH_CHANNEL,
    () => runtime.setListenerHealthy(true),
    () => runtime.setListenerHealthy(true),
  );
  runtime.setListenerHealthy(true);

  const heartbeat = setInterval(() => {
    void sql.notify(FLAG_LISTENER_HEALTH_CHANNEL, crypto.randomUUID()).catch(() => {
      runtime.setListenerHealthy(false);
    });
  }, heartbeatMs);
  heartbeat.unref?.();

  let closed = false;

  return {
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      clearInterval(heartbeat);
      runtime.setListenerHealthy(false);
      await Promise.all([subscription.unlisten(), health.unlisten()]);
    },
  };
}

/** The viewer used by server accessors: a member's group keys, or the Guests pseudo-group. */
export async function loadFlagViewer(sql: SQL, memberId: string | null): Promise<FlagViewer> {
  if (memberId === null) {
    return GUEST_VIEWER;
  }

  const rows = (await sql`
    SELECT g.key
    FROM core.member_groups mg
    JOIN core.groups g ON g.id = mg.group_id
    WHERE mg.member_id = ${memberId}
    ORDER BY g.key
  `) as Array<{ key: string }>;

  return { memberId, groups: rows.map((row) => row.key) };
}
