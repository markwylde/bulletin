import { emit } from "@bulletin/db/events";
import {
  bumpPermVersion,
  capabilityBitMask,
  FORUM_ACTIONS,
  type ForumAction,
  type ForumMatrixRow,
  isForumAction,
  loadForumTree,
  resolveForumMaskActions,
} from "@bulletin/domain/permissions";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";

const MASK_KEY = /^[a-z][a-z0-9_]*$/;

export interface PermissionMaskView {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly isSystem: boolean;
  readonly displayOrder: number;
  readonly groupIds: readonly string[];
}

export interface PermissionMatrixView {
  readonly enabled: boolean;
  readonly groups: ReadonlyArray<{ id: string; key: string; title: string }>;
  readonly masks: readonly PermissionMaskView[];
  readonly forums: ReadonlyArray<{ id: string; parentId: string | null }>;
  readonly actions: readonly ForumAction[];
  readonly rows: ReadonlyArray<{
    forumId: string;
    maskId: string;
    actions: number;
    inherits: boolean;
    effectiveActions: number;
  }>;
}

export interface MaskMutationFailure {
  readonly ok: false;
  readonly code:
    | "invalid_request"
    | "invalid_mask"
    | "duplicate_key"
    | "not_found"
    | "system_mask"
    | "invalid_forum"
    | "invalid_action";
}

export type MaskMutation = { readonly ok: true } | MaskMutationFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("code" in error && (error as { code?: string }).code === "23505") ||
      ("errno" in error && (error as { errno?: string }).errno === "23505"))
  );
}

function validTitle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const title = value.trim();
  return title.length > 0 && title.length <= 100 ? title : null;
}

interface MaskRow {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly is_system: boolean;
  readonly display_order: number;
}

interface ForumPermissionRow {
  readonly forum_id: string;
  readonly mask_id: string;
  readonly actions: number;
  readonly inherits: boolean;
}

async function emitForumVisibility(tx: SQL, forumId: string, permVersion: string): Promise<void> {
  await emit(tx, {
    type: "forum.visibility.changed",
    aggregateId: BigInt(forumId),
    aggregateVersion: BigInt(permVersion),
    payloadIds: { forumId: BigInt(forumId) },
  });
}

/**
 * A mask link, unlink or delete is global: it can change guest visibility on any forum.
 * Emitting one event per root covers every subtree the worker has to purge (ADR 0006).
 */
async function emitAllForumsVisibility(tx: SQL, permVersion: string): Promise<void> {
  const tree = await loadForumTree(tx);

  for (const root of tree.roots) {
    await emitForumVisibility(tx, root.id, permVersion);
  }
}

async function matrixRows(sql: SQL): Promise<readonly ForumMatrixRow[]> {
  const rows = (await sql`
    SELECT forum_id, mask_id, actions, inherits FROM core.forum_permissions
  `) as ForumPermissionRow[];

  return rows.map((row) => ({
    forumId: row.forum_id,
    maskId: row.mask_id,
    actions: row.actions,
    inherits: row.inherits,
  }));
}

export async function listPermissionMatrix(sql: SQL): Promise<PermissionMatrixView> {
  const tree = await loadForumTree(sql);
  const groups = (await sql`
    SELECT id, key, title FROM core.groups ORDER BY display_order, id
  `) as Array<{ id: string; key: string; title: string }>;
  const maskRows = (await sql`
    SELECT id, key, title, description, is_system, display_order
    FROM core.masks
    ORDER BY display_order, key
  `) as MaskRow[];
  const links = (await sql`
    SELECT group_id, mask_id FROM core.group_masks
  `) as Array<{ group_id: string; mask_id: string }>;
  const rows = await matrixRows(sql);
  const byKey = new Map(rows.map((row) => [`${row.forumId}|${row.maskId}`, row]));

  const masks: PermissionMaskView[] = maskRows.map((mask) => ({
    id: mask.id,
    key: mask.key,
    title: mask.title,
    description: mask.description,
    isSystem: mask.is_system,
    displayOrder: mask.display_order,
    groupIds: links.filter((link) => link.mask_id === mask.id).map((link) => link.group_id),
  }));

  const matrix = [];

  for (const forumId of tree.ids) {
    for (const mask of masks) {
      const row = byKey.get(`${forumId}|${mask.id}`);
      matrix.push({
        forumId,
        maskId: mask.id,
        actions: row?.actions ?? 0,
        inherits: row?.inherits ?? true,
        effectiveActions: resolveForumMaskActions(tree, rows, forumId, mask.id),
      });
    }
  }

  return {
    enabled: tree.ids.length > 0,
    groups,
    masks,
    forums: tree.ids.map((id) => ({ id, parentId: tree.get(id)?.parentId ?? null })),
    actions: FORUM_ACTIONS,
    rows: matrix,
  };
}

export async function saveMask(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<MaskMutation> {
  if (!isRecord(input)) {
    return { ok: false, code: "invalid_request" };
  }

  const id = typeof input.id === "string" ? input.id : null;
  const key = typeof input.key === "string" ? input.key.trim() : "";
  const title = validTitle(input.title);
  const description = typeof input.description === "string" ? input.description : "";
  const displayOrder =
    typeof input.displayOrder === "number" && Number.isInteger(input.displayOrder)
      ? input.displayOrder
      : 0;

  if (!MASK_KEY.test(key) || title === null) {
    return { ok: false, code: "invalid_mask" };
  }

  try {
    return await sql.begin(async (tx) => {
      if (id === null) {
        const [mask] = (await tx`
          INSERT INTO core.masks (key, title, description, display_order)
          VALUES (${key}, ${title}, ${description}, ${displayOrder})
          RETURNING id
        `) as Array<{ id: string }>;

        if (mask === undefined) {
          throw new Error("Mask insert returned no row");
        }

        await bumpPermVersion(tx);
        await writeAdminLog(tx, {
          actorMemberId,
          action: "mask.create",
          targetType: "mask",
          targetId: mask.id,
          summary: { key, title },
        });
        return { ok: true } as const;
      }

      const [before] = (await tx`
        SELECT id, key, title, description, is_system, display_order
        FROM core.masks
        WHERE id = ${id}
        FOR UPDATE
      `) as MaskRow[];

      if (before === undefined) {
        return { ok: false, code: "not_found" } as const;
      }

      await tx`
        UPDATE core.masks
        SET key = ${key}, title = ${title}, description = ${description},
            display_order = ${displayOrder}
        WHERE id = ${id}
      `;
      await bumpPermVersion(tx);
      await writeAdminLog(tx, {
        actorMemberId,
        action: "mask.update",
        targetType: "mask",
        targetId: id,
        summary: {
          before: { key: before.key, title: before.title },
          after: { key, title },
        },
      });
      return { ok: true } as const;
    });
  } catch (error) {
    return { ok: false, code: isUniqueViolation(error) ? "duplicate_key" : "invalid_mask" };
  }
}

export async function deleteMask(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<MaskMutation> {
  if (!isRecord(input) || typeof input.id !== "string") {
    return { ok: false, code: "invalid_request" };
  }

  return sql.begin(async (tx) => {
    const [mask] = (await tx`
      SELECT id, key, title, is_system FROM core.masks WHERE id = ${input.id} FOR UPDATE
    `) as MaskRow[];

    if (mask === undefined) {
      return { ok: false, code: "not_found" } as const;
    }

    if (mask.is_system) {
      return { ok: false, code: "system_mask" } as const;
    }

    await tx`DELETE FROM core.masks WHERE id = ${input.id}`;
    const permVersion = await bumpPermVersion(tx);
    await emitAllForumsVisibility(tx, permVersion);
    await writeAdminLog(tx, {
      actorMemberId,
      action: "mask.delete",
      targetType: "mask",
      targetId: mask.id,
      summary: { key: mask.key, title: mask.title },
    });
    return { ok: true } as const;
  });
}

export async function linkGroupMask(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<MaskMutation> {
  if (
    !isRecord(input) ||
    typeof input.groupId !== "string" ||
    typeof input.maskId !== "string" ||
    typeof input.linked !== "boolean"
  ) {
    return { ok: false, code: "invalid_request" };
  }

  return sql.begin(async (tx) => {
    const [group] = (await tx`
      SELECT id, key FROM core.groups WHERE id = ${input.groupId}
    `) as Array<{ id: string; key: string }>;
    const [mask] = (await tx`
      SELECT id, key FROM core.masks WHERE id = ${input.maskId}
    `) as Array<{ id: string; key: string }>;

    if (group === undefined || mask === undefined) {
      return { ok: false, code: "not_found" } as const;
    }

    if (input.linked) {
      await tx`
        INSERT INTO core.group_masks (group_id, mask_id)
        VALUES (${input.groupId}, ${input.maskId})
        ON CONFLICT DO NOTHING
      `;
    } else {
      await tx`
        DELETE FROM core.group_masks
        WHERE group_id = ${input.groupId} AND mask_id = ${input.maskId}
      `;
    }

    const permVersion = await bumpPermVersion(tx);
    await emitAllForumsVisibility(tx, permVersion);
    await writeAdminLog(tx, {
      actorMemberId,
      action: "mask.link",
      targetType: "group",
      targetId: group.id,
      summary: { group: group.key, mask: mask.key, linked: input.linked },
    });
    return { ok: true } as const;
  });
}

async function lockMask(tx: SQL, maskId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`bulletin.mask_matrix:${maskId}`})::bigint)`;
}

async function setMatrixActions(
  tx: SQL,
  forumId: string,
  maskId: string,
  actions: number,
): Promise<void> {
  await tx`
    INSERT INTO core.forum_permissions (forum_id, mask_id, actions, inherits, updated_at)
    VALUES (${forumId}, ${maskId}, ${actions}, false, now())
    ON CONFLICT (forum_id, mask_id) DO UPDATE
      SET actions = EXCLUDED.actions, inherits = false, updated_at = now()
  `;
}

export async function saveMatrixCell(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<MaskMutation> {
  if (
    !isRecord(input) ||
    typeof input.forumId !== "string" ||
    typeof input.maskId !== "string" ||
    typeof input.permissionAction !== "string" ||
    typeof input.allowed !== "boolean"
  ) {
    return { ok: false, code: "invalid_request" };
  }

  if (!isForumAction(input.permissionAction)) {
    return { ok: false, code: "invalid_action" };
  }

  const action = input.permissionAction;
  const forumId = input.forumId;
  const maskId = input.maskId;
  const allowed = input.allowed;

  return sql.begin(async (tx) => {
    // Serialize matrix edits for a mask before reading inherited values.
    await lockMask(tx, maskId);
    const tree = await loadForumTree(tx);
    const [mask] = (await tx`
      SELECT id, key FROM core.masks WHERE id = ${maskId}
    `) as Array<{ id: string; key: string }>;

    if (tree.get(forumId) === undefined || mask === undefined) {
      return { ok: false, code: "not_found" } as const;
    }

    if (input.inherits === true) {
      await tx`
        DELETE FROM core.forum_permissions
        WHERE forum_id = ${forumId} AND mask_id = ${maskId}
      `;
    } else {
      const rows = await matrixRows(tx);
      const effective = resolveForumMaskActions(tree, rows, forumId, maskId);
      const bit = capabilityBitMask(action);
      const actions = allowed ? effective | bit : effective & ~bit;
      await setMatrixActions(tx, forumId, maskId, actions);
    }

    const permVersion = await bumpPermVersion(tx);
    await emitForumVisibility(tx, forumId, permVersion);
    await writeAdminLog(tx, {
      actorMemberId,
      action: "mask.matrix.update",
      targetType: "mask",
      targetId: mask.id,
      summary: {
        forumId,
        mask: mask.key,
        action,
        allowed,
        inherits: input.inherits === true,
      },
    });
    return { ok: true } as const;
  });
}

export async function bulkToggleMatrix(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<MaskMutation> {
  if (
    !isRecord(input) ||
    typeof input.permissionAction !== "string" ||
    typeof input.allowed !== "boolean"
  ) {
    return { ok: false, code: "invalid_request" };
  }

  if (!isForumAction(input.permissionAction)) {
    return { ok: false, code: "invalid_action" };
  }

  if (typeof input.forumId !== "string") {
    return { ok: false, code: "invalid_request" };
  }

  if (input.maskId !== undefined && typeof input.maskId !== "string") {
    return { ok: false, code: "invalid_request" };
  }

  const action = input.permissionAction;
  const allowed = input.allowed;
  const forumId = input.forumId;
  const maskId = typeof input.maskId === "string" ? input.maskId : null;
  const bit = capabilityBitMask(action);

  return sql.begin(async (tx) => {
    const tree = await loadForumTree(tx);
    const allMasks = (await tx`
      SELECT id, key FROM core.masks ORDER BY id
    `) as Array<{ id: string; key: string }>;

    // A row bulk toggles every mask at one forum. A column bulk toggles one mask at one
    // forum (typically a category); descendants inherit and explicit overrides stay untouched.
    const scope: "row" | "column" = maskId === null ? "row" : "column";
    const scopeId = forumId;
    const targetForums = [forumId];
    const targetMasks = maskId === null ? allMasks : allMasks.filter((mask) => mask.id === maskId);

    if (targetMasks.length === 0 || tree.get(forumId) === undefined) {
      return { ok: false, code: "not_found" } as const;
    }

    // Lock every affected mask in sorted order so row bulk cannot deadlock with other edits.
    for (const mask of [...targetMasks].sort((left, right) => left.id.localeCompare(right.id))) {
      await lockMask(tx, mask.id);
    }

    const rows = await matrixRows(tx);
    const updates: Array<{ forumId: string; mask: { id: string; key: string }; actions: number }> =
      [];

    for (const mask of targetMasks) {
      for (const forumId of targetForums) {
        const effective = resolveForumMaskActions(tree, rows, forumId, mask.id);
        const actions = allowed ? effective | bit : effective & ~bit;
        updates.push({ forumId, mask, actions });
      }
    }

    for (const update of updates) {
      await setMatrixActions(tx, update.forumId, update.mask.id, update.actions);
    }

    const permVersion = await bumpPermVersion(tx);
    await emitForumVisibility(tx, forumId, permVersion);
    await writeAdminLog(tx, {
      actorMemberId,
      action: "mask.matrix.bulk",
      targetType: "mask",
      targetId: targetMasks.length === 1 ? (targetMasks[0]?.id ?? null) : null,
      summary: {
        scope,
        scopeId,
        action,
        allowed,
        masks: targetMasks.map((mask) => mask.key),
        forums: targetForums,
      },
    });
    return { ok: true } as const;
  });
}
