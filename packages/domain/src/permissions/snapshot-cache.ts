import { createBoundedCache } from "@bulletin/cache";
import type { SQL } from "bun";
import { readPermVersion } from "./perm-version.ts";
import type { CompiledGroupSnapshot, PermissionData } from "./snapshot.ts";

export interface PermissionSnapshotCacheOptions {
  readonly readVersion: () => Promise<string>;
  readonly now?: () => number;
  /** How often the `perm` tag is re-read; the worst-case revocation window (ADR 0006). */
  readonly backstopMs?: number;
  readonly maxBytes?: number;
}

export interface PermissionSnapshotCache {
  /** Static compiler inputs (tree, group→mask links, matrix, global powers). */
  data(load: () => Promise<PermissionData>): Promise<PermissionData>;
  /** Group snapshots shared by every member with the same sorted group-ID set. */
  group(key: string, load: () => Promise<CompiledGroupSnapshot>): Promise<CompiledGroupSnapshot>;
  invalidate(): void;
}

interface Entry<T> {
  readonly version: string;
  readonly value: T;
}

const DEFAULT_BACKSTOP_MS = 1_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

function groupSnapshotBytes(snapshot: CompiledGroupSnapshot): number {
  return 256 + snapshot.bits.size * 24 + snapshot.globalPowers.size * 16;
}

/**
 * An in-process cache for compiled permission snapshots (ADR 0006). Entries are validated
 * against the durable `perm` tag at most once per `backstopMs`; a NOTIFY-aware listener can
 * call `invalidate()` sooner, but the backstop alone bounds revocation to one second.
 */
export function createPermissionSnapshotCache(
  options: PermissionSnapshotCacheOptions,
): PermissionSnapshotCache {
  const now = options.now ?? Date.now;
  const backstopMs = options.backstopMs ?? DEFAULT_BACKSTOP_MS;
  const groups = createBoundedCache<string, Entry<CompiledGroupSnapshot>>({
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
  });

  let dataEntry: Entry<PermissionData> | null = null;
  let currentVersion: string | null = null;
  let lastCheck = Number.NEGATIVE_INFINITY;

  function clear(): void {
    dataEntry = null;
    groups.clear();
  }

  async function version(): Promise<string> {
    const timestamp = now();

    if (currentVersion === null || timestamp - lastCheck >= backstopMs) {
      const next = await options.readVersion();
      lastCheck = timestamp;

      if (currentVersion !== null && currentVersion !== next) {
        clear();
      }

      currentVersion = next;
    }

    return currentVersion;
  }

  return {
    async data(load) {
      const current = await version();

      if (dataEntry !== null && dataEntry.version === current) {
        return dataEntry.value;
      }

      const value = await load();
      dataEntry = { version: current, value };
      return value;
    },

    async group(key, load) {
      const current = await version();
      const cached = groups.get(key);

      if (cached !== undefined && cached.version === current) {
        return cached.value;
      }

      const value = await load();
      groups.set(key, { version: current, value }, groupSnapshotBytes(value));
      return value;
    },

    invalidate() {
      currentVersion = null;
      lastCheck = Number.NEGATIVE_INFINITY;
      clear();
    },
  };
}

/** The default `perm` tag reader for a SQL connection. */
export function createSqlPermVersionReader(sql: SQL): () => Promise<string> {
  return () => readPermVersion(sql);
}
