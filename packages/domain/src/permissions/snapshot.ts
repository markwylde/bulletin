import type { SQL } from "bun";
import {
  type CapabilityBit,
  capabilityBitMask,
  hasCapabilityBit,
  isModeratorPower,
  MODERATOR_POWERS,
  type ModeratorPower,
} from "./actions.ts";
import type { CapabilitySnapshot } from "./capability.ts";
import { type ModeratorAssignment, memberBanned } from "./moderator.ts";
import { type MergedGroupSettings, mergeGroupSettings } from "./registry.ts";
import { loadMemberGroups, loadModeratorAssignments, loadSessionUnlocks } from "./store.ts";
import type { ForumTree } from "./tree.ts";
import { loadForumTree } from "./tree-store.ts";

export interface ForumMatrixRow {
  readonly forumId: string;
  readonly maskId: string;
  readonly actions: number;
  /** When true this forum defers to its parent's row for the mask (ADR 0005). */
  readonly inherits: boolean;
}

export interface PermissionData {
  readonly tree: ForumTree;
  /** Mask IDs linked to each group (`core.group_masks`). */
  readonly masksByGroup: ReadonlyMap<string, readonly string[]>;
  readonly matrix: readonly ForumMatrixRow[];
  /** Moderator powers granted board-wide by a group setting (super moderators). */
  readonly globalPowersByGroup: ReadonlyMap<string, readonly ModeratorPower[]>;
}

export interface CompiledGroupSnapshot {
  readonly bits: ReadonlyMap<string, number>;
  readonly globalPowers: ReadonlySet<ModeratorPower>;
}

/** Everything one request needs, before the session's password unlocks are attached. */
export interface PermissionSnapshot extends CapabilitySnapshot {
  readonly memberId: string;
  readonly groupIds: readonly string[];
  readonly primaryGroupId: string | null;
  readonly settings: MergedGroupSettings;
  readonly globalPowers: ReadonlySet<ModeratorPower>;
}

export type LoadedPermissionSnapshot = Omit<PermissionSnapshot, "unlocked">;

const SHOW_MASK = capabilityBitMask("show");
const READ_MASK = capabilityBitMask("read");

function matrixKey(forumId: string, maskId: string): string {
  return `${forumId}|${maskId}`;
}

function buildMatrixIndex(matrix: readonly ForumMatrixRow[]): ReadonlyMap<string, ForumMatrixRow> {
  const index = new Map<string, ForumMatrixRow>();

  for (const row of matrix) {
    index.set(matrixKey(row.forumId, row.maskId), row);
  }

  return index;
}

/**
 * Resolves a mask's action bits for a forum through the inheritance chain: a row replaces the
 * inherited value when `inherits` is false, otherwise the parent's resolution is kept.
 */
export function resolveForumMaskActions(
  tree: ForumTree,
  matrix: readonly ForumMatrixRow[],
  forumId: string,
  maskId: string,
): number {
  return resolveMaskActions(tree, buildMatrixIndex(matrix), forumId, maskId);
}

function resolveMaskActions(
  tree: ForumTree,
  index: ReadonlyMap<string, ForumMatrixRow>,
  forumId: string,
  maskId: string,
): number {
  let actions = 0;

  for (const node of tree.lineage(forumId)) {
    const row = index.get(matrixKey(node.id, maskId));

    if (row !== undefined) {
      actions = row.inherits ? actions : row.actions;
    }
  }

  return actions;
}

function viewerMasks(data: PermissionData, groupIds: readonly string[]): ReadonlySet<string> {
  const masks = new Set<string>();

  for (const groupId of groupIds) {
    for (const maskId of data.masksByGroup.get(groupId) ?? []) {
      masks.add(maskId);
    }
  }

  return masks;
}

function globalPowersFor(
  data: PermissionData,
  groupIds: readonly string[],
): ReadonlySet<ModeratorPower> {
  const powers = new Set<ModeratorPower>();

  for (const groupId of groupIds) {
    for (const power of data.globalPowersByGroup.get(groupId) ?? []) {
      powers.add(power);
    }
  }

  return powers;
}

/**
 * Applies the ancestor rule (ADR 0005) to a compiled bitmap: an action on a forum is allowed
 * only when the viewer has `show` on the forum and every ancestor. A hidden parent hides the
 * whole subtree.
 */
export function applyAncestorShow(tree: ForumTree, bits: Map<string, number>): void {
  for (const forumId of tree.ids) {
    const visible = tree
      .lineage(forumId)
      .every((node) => ((bits.get(node.id) ?? 0) & SHOW_MASK) !== 0);

    if (!visible) {
      bits.set(forumId, 0);
    }
  }
}

/**
 * Compiles the group layer for one sorted group-ID set (ADR 0005): the union of the groups'
 * masks per forum, `read` implies `show`, global moderator powers, then the ancestor rule.
 * The result is shared by every member with that group set.
 */
export function compileGroupSnapshot(
  data: PermissionData,
  groupIds: readonly string[],
): CompiledGroupSnapshot {
  const masks = viewerMasks(data, groupIds);
  const index = buildMatrixIndex(data.matrix);
  const globalPowers = globalPowersFor(data, groupIds);
  const globalPowerBits = [...globalPowers].reduce(
    (bits, power) => bits | capabilityBitMask(power),
    0,
  );
  const bits = new Map<string, number>();

  for (const forumId of data.tree.ids) {
    let actions = 0;

    for (const maskId of masks) {
      actions |= resolveMaskActions(data.tree, index, forumId, maskId);
    }

    if ((actions & READ_MASK) !== 0) {
      actions |= SHOW_MASK;
    }

    // Moderator powers are only meaningful in forums the viewer can read; assignments and the
    // global group setting never open a forum the masks hide.
    if ((actions & READ_MASK) !== 0) {
      actions |= globalPowerBits;
    }

    bits.set(forumId, actions);
  }

  applyAncestorShow(data.tree, bits);

  return { bits, globalPowers };
}

const POWER_BITS: ReadonlyMap<ModeratorPower, number> = new Map(
  MODERATOR_POWERS.map((power) => [power, capabilityBitMask(power)]),
);

const POWER_MASK = [...POWER_BITS.values()].reduce((mask, bit) => mask | bit, 0);

/**
 * Adds the member layer (ADR 0005): member and group moderator assignments are ORed into the
 * group snapshot and the ancestor rule is applied again. The session layer is added by the
 * caller because unlocks change per request.
 */
export function compileMemberSnapshot(input: {
  readonly groupSnapshot: CompiledGroupSnapshot;
  readonly assignments: readonly ModeratorAssignment[];
  readonly tree: ForumTree;
  readonly memberId: string;
  readonly groupIds: readonly string[];
  readonly primaryGroupId: string | null;
  readonly settings: MergedGroupSettings;
  readonly banned: boolean;
}): LoadedPermissionSnapshot {
  const bits = new Map(input.groupSnapshot.bits);

  for (const assignment of input.assignments) {
    const assigneeMatches =
      assignment.memberId === input.memberId ||
      (assignment.groupId !== null && input.groupIds.includes(assignment.groupId));

    if (!assigneeMatches) {
      continue;
    }

    const powerBits = assignment.powers.reduce(
      (mask, power) => mask | (POWER_BITS.get(power) ?? 0),
      0,
    );

    if (powerBits === 0) {
      continue;
    }

    const forums =
      input.tree.get(assignment.forumId) === undefined
        ? []
        : assignment.thisForumOnly
          ? [assignment.forumId]
          : [
              assignment.forumId,
              ...input.tree.descendants(assignment.forumId).map((node) => node.id),
            ];

    for (const forumId of forums) {
      // Keep moderator bits inside forums the member can read.
      if ((bits.get(forumId) ?? 0) & READ_MASK) {
        bits.set(forumId, (bits.get(forumId) ?? 0) | powerBits);
      }
    }
  }

  // A banned member can still read, but has no moderator powers (ADR 0005).
  if (input.banned) {
    for (const [forumId, value] of bits) {
      bits.set(forumId, value & ~POWER_MASK);
    }
  }

  applyAncestorShow(input.tree, bits);

  return {
    memberId: input.memberId,
    groupIds: input.groupIds,
    primaryGroupId: input.primaryGroupId,
    settings: input.settings,
    globalPowers: input.groupSnapshot.globalPowers,
    tree: input.tree,
    bits,
  };
}

/** Loads the static inputs of the compiler: tree, group→mask links, matrix and global powers. */
export async function loadPermissionData(sql: SQL, tree?: ForumTree): Promise<PermissionData> {
  const resolvedTree = tree ?? (await loadForumTree(sql));

  const maskRows = (await sql`
    SELECT group_id, mask_id
    FROM core.group_masks
  `) as Array<{ group_id: string; mask_id: string }>;

  const matrixRows = (await sql`
    SELECT forum_id, mask_id, actions, inherits
    FROM core.forum_permissions
  `) as Array<{
    forum_id: string;
    mask_id: string;
    actions: number;
    inherits: boolean;
  }>;

  const settingRows = (await sql`
    SELECT group_id, key
    FROM core.group_settings
    WHERE key LIKE 'moderation.%'
      AND value = 'true'::jsonb
  `) as Array<{ group_id: string; key: string }>;

  const masksByGroup = new Map<string, string[]>();

  for (const row of maskRows) {
    const masks = masksByGroup.get(row.group_id) ?? [];
    masks.push(row.mask_id);
    masksByGroup.set(row.group_id, masks);
  }

  const globalPowersByGroup = new Map<string, ModeratorPower[]>();

  for (const row of settingRows) {
    const power = row.key.slice("moderation.".length);

    if (!isModeratorPower(power)) {
      continue;
    }

    const powers = globalPowersByGroup.get(row.group_id) ?? [];
    powers.push(power);
    globalPowersByGroup.set(row.group_id, powers);
  }

  return {
    tree: resolvedTree,
    masksByGroup,
    matrix: matrixRows.map((row) => ({
      forumId: row.forum_id,
      maskId: row.mask_id,
      actions: row.actions,
      inherits: row.inherits,
    })),
    globalPowersByGroup,
  };
}

export interface LoadPermissionSnapshotOptions {
  readonly tree: ForumTree;
  readonly sessionId?: string | null;
}

/** Loads and compiles one member's snapshot without an in-process cache. */
export async function loadPermissionSnapshot(
  sql: SQL,
  memberId: string,
  options: LoadPermissionSnapshotOptions,
): Promise<PermissionSnapshot> {
  const [data, groups, assignments, unlocked] = await Promise.all([
    loadPermissionData(sql, options.tree),
    loadMemberGroups(sql, memberId),
    loadModeratorAssignments(sql, memberId),
    loadSessionUnlocks(sql, options.sessionId ?? null),
  ]);

  const groupIds = groups.map((group) => group.groupId).sort();
  const groupSnapshot = compileGroupSnapshot(data, groupIds);
  const settings = mergeGroupSettings(groups);
  const primaryGroupId = groups.find((group) => group.isPrimary)?.groupId ?? null;
  const banned = memberBanned(groups, settings);

  return {
    ...compileMemberSnapshot({
      groupSnapshot,
      assignments,
      tree: options.tree,
      memberId,
      groupIds,
      primaryGroupId,
      settings,
      banned,
    }),
    unlocked,
  };
}

/** Reads one capability answer, folding password unlocks into `read` (ADR 0005). */
export function capabilityAnswer(
  snapshot: CapabilitySnapshot,
  forumId: string,
  bit: CapabilityBit,
): boolean {
  const node = snapshot.tree.get(forumId);

  if (node === undefined) {
    return false;
  }

  const base = hasCapabilityBit(snapshot.bits.get(forumId) ?? 0, bit);

  if (bit === "read" && node.passwordProtected) {
    return base && snapshot.unlocked.has(forumId);
  }

  return base;
}
