import type { SQL } from "bun";
import { hasCapabilityBit, isForumAction, isModeratorPower } from "./actions.ts";
import { can, type PermissionAction, type PermissionScope } from "./can.ts";
import { memberBanned } from "./moderator.ts";
import { mergeGroupSettings } from "./registry.ts";
import {
  capabilityAnswer,
  compileGroupSnapshot,
  compileMemberSnapshot,
  loadPermissionData,
  type PermissionSnapshot,
} from "./snapshot.ts";
import { createPermissionSnapshotCache, createSqlPermVersionReader } from "./snapshot-cache.ts";
import { loadMemberGroups, loadModeratorAssignments, loadSessionUnlocks } from "./store.ts";

export interface PermissionServiceOptions {
  readonly sql: SQL;
  /** Test seam for the 1 s backstop. */
  readonly now?: () => number;
  readonly backstopMs?: number;
  readonly maxBytes?: number;
  readonly readVersion?: () => Promise<string>;
}

export interface PermissionSnapshotRequest {
  readonly sessionId?: string | null;
}

export interface PermissionService {
  /** The compiled snapshot for one request, including the session's password unlocks. */
  snapshot(memberId: string, request?: PermissionSnapshotRequest): Promise<PermissionSnapshot>;
  can(memberId: string, action: PermissionAction, scope?: PermissionScope): Promise<boolean>;
  /** Drops cached snapshots; the NOTIFY listener will call this when it learns of `perm`. */
  invalidate(): void;
}

/**
 * The per-process permission evaluator (ADR 0005, 0006). Group snapshots are cached by the
 * sorted group-ID set and validated against the `perm` tag at most once per second. Member
 * assignments and session unlocks are layered on per request.
 */
export function createPermissionService(options: PermissionServiceOptions): PermissionService {
  const cache = createPermissionSnapshotCache({
    readVersion: options.readVersion ?? createSqlPermVersionReader(options.sql),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.backstopMs === undefined ? {} : { backstopMs: options.backstopMs }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });

  async function snapshot(
    memberId: string,
    request: PermissionSnapshotRequest = {},
  ): Promise<PermissionSnapshot> {
    const data = await cache.data(() => loadPermissionData(options.sql));
    const groups = await loadMemberGroups(options.sql, memberId);
    const groupIds = groups.map((group) => group.groupId).sort();
    const groupSnapshot = await cache.group(groupIds.join(","), async () =>
      compileGroupSnapshot(data, groupIds),
    );
    const assignments = await loadModeratorAssignments(options.sql, memberId);
    const settings = mergeGroupSettings(groups);
    const primaryGroupId = groups.find((group) => group.isPrimary)?.groupId ?? null;
    const banned = memberBanned(groups, settings);
    const loaded = compileMemberSnapshot({
      groupSnapshot,
      assignments,
      tree: data.tree,
      memberId,
      groupIds,
      primaryGroupId,
      settings,
      banned,
    });
    const unlocked = await loadSessionUnlocks(options.sql, request.sessionId ?? null);

    return { ...loaded, unlocked };
  }

  return {
    snapshot,

    async can(memberId, action, scope) {
      if (isModeratorPower(action)) {
        if (scope === undefined) {
          return false;
        }

        const compiled =
          scope.snapshot ?? (await snapshot(memberId, { sessionId: scope.sessionId ?? null }));
        return hasCapabilityBit(compiled.bits.get(scope.forumId) ?? 0, action);
      }

      if (isForumAction(action)) {
        if (scope === undefined) {
          return false;
        }

        const compiled =
          scope.snapshot ?? (await snapshot(memberId, { sessionId: scope.sessionId ?? null }));
        return capabilityAnswer(compiled, scope.forumId, action);
      }

      return can(options.sql, memberId, action);
    },

    invalidate() {
      cache.invalidate();
    },
  };
}
