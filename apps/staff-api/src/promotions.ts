import { promotionCriteria } from "@bulletin/domain/permissions";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";

export interface PromotionRuleView {
  readonly id: string;
  readonly fromGroupId: string;
  readonly toGroupId: string;
  readonly fromGroupKey: string;
  readonly toGroupKey: string;
  readonly criteria: Readonly<Record<string, number>>;
  readonly position: number;
  readonly enabled: boolean;
}

export interface PromotionView {
  readonly rules: readonly PromotionRuleView[];
  readonly groups: ReadonlyArray<{ id: string; key: string; title: string }>;
  readonly criteria: ReadonlyArray<{ key: string; labelKey: string }>;
}

export type PromotionMutation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "invalid_request" | "invalid_group" | "invalid_criteria" | "not_found";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RuleRow {
  readonly id: string;
  readonly from_group_id: string;
  readonly to_group_id: string;
  readonly from_key: string;
  readonly to_key: string;
  readonly criteria: unknown;
  readonly position: number;
  readonly enabled: boolean;
}

function parseCriteria(value: unknown): Record<string, number> {
  if (typeof value === "string") {
    try {
      return parseCriteria(JSON.parse(value));
    } catch {
      return {};
    }
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const criteria: Record<string, number> = {};

  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      criteria[key] = raw;
    }
  }

  return criteria;
}

export async function listPromotions(sql: SQL): Promise<PromotionView> {
  const rows = (await sql`
    SELECT r.id, r.from_group_id, r.to_group_id,
           from_group.key AS from_key, to_group.key AS to_key,
           r.criteria, r.position, r.enabled
    FROM core.promotion_rules r
    JOIN core.groups from_group ON from_group.id = r.from_group_id
    JOIN core.groups to_group ON to_group.id = r.to_group_id
    ORDER BY r.position, r.id
  `) as RuleRow[];
  const groups = (await sql`
    SELECT id, key, title FROM core.groups ORDER BY display_order, id
  `) as Array<{ id: string; key: string; title: string }>;

  return {
    rules: rows.map((row) => ({
      id: row.id,
      fromGroupId: row.from_group_id,
      toGroupId: row.to_group_id,
      fromGroupKey: row.from_key,
      toGroupKey: row.to_key,
      criteria: parseCriteria(row.criteria),
      position: row.position,
      enabled: row.enabled,
    })),
    groups,
    criteria: promotionCriteria.list().map((criterion) => ({
      key: criterion.key,
      labelKey: criterion.labelKey,
    })),
  };
}

export async function savePromotionRule(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<PromotionMutation> {
  if (
    !isRecord(input) ||
    typeof input.fromGroupId !== "string" ||
    typeof input.toGroupId !== "string" ||
    !isRecord(input.criteria)
  ) {
    return { ok: false, code: "invalid_request" };
  }

  if (input.fromGroupId === input.toGroupId) {
    return { ok: false, code: "invalid_group" };
  }

  const known = new Set(promotionCriteria.list().map((criterion) => criterion.key));
  const criteria: Record<string, number> = {};

  for (const [key, value] of Object.entries(input.criteria)) {
    if (!known.has(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return { ok: false, code: "invalid_criteria" };
    }

    criteria[key] = value;
  }

  const position =
    typeof input.position === "number" && Number.isInteger(input.position) ? input.position : 0;
  const enabled = input.enabled !== false;
  const id = typeof input.id === "string" ? input.id : null;

  return sql.begin(async (tx) => {
    const groups = (await tx`
      SELECT id, key FROM core.groups
      WHERE id = ANY(${`{${[input.fromGroupId, input.toGroupId].join(",")}}`}::bigint[])
    `) as Array<{ id: string; key: string }>;

    if (groups.length !== 2) {
      return { ok: false, code: "invalid_group" } as const;
    }

    if (id === null) {
      const [inserted] = (await tx`
        INSERT INTO core.promotion_rules (
          from_group_id, to_group_id, criteria, position, enabled
        ) VALUES (
          ${input.fromGroupId}, ${input.toGroupId}, ${criteria}, ${position}, ${enabled}
        )
        RETURNING id
      `) as Array<{ id: string }>;

      if (inserted === undefined) {
        throw new Error("Promotion rule insert returned no row");
      }

      await writeAdminLog(tx, {
        actorMemberId,
        action: "promotion.rule.create",
        targetType: "promotion_rule",
        targetId: inserted.id,
        summary: { groups: groups.map((group) => group.key), criteria, position, enabled },
      });
      return { ok: true } as const;
    }

    const [before] = (await tx`
      SELECT id, from_group_id, to_group_id, criteria, position, enabled
      FROM core.promotion_rules
      WHERE id = ${id}
      FOR UPDATE
    `) as Array<{
      id: string;
      from_group_id: string;
      to_group_id: string;
      criteria: unknown;
      position: number;
      enabled: boolean;
    }>;

    if (before === undefined) {
      return { ok: false, code: "not_found" } as const;
    }

    await tx`
      UPDATE core.promotion_rules
      SET from_group_id = ${input.fromGroupId},
          to_group_id = ${input.toGroupId},
          criteria = ${criteria},
          position = ${position},
          enabled = ${enabled},
          updated_at = now()
      WHERE id = ${id}
    `;
    await writeAdminLog(tx, {
      actorMemberId,
      action: "promotion.rule.update",
      targetType: "promotion_rule",
      targetId: id,
      summary: {
        before: {
          fromGroupId: before.from_group_id,
          toGroupId: before.to_group_id,
          criteria: parseCriteria(before.criteria),
          position: before.position,
          enabled: before.enabled,
        },
        after: { criteria, position, enabled },
      },
    });
    return { ok: true } as const;
  });
}

export async function deletePromotionRule(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<PromotionMutation> {
  if (!isRecord(input) || typeof input.id !== "string") {
    return { ok: false, code: "invalid_request" };
  }

  const id = input.id;

  return sql.begin(async (tx) => {
    const [before] = (await tx`
      SELECT id, from_group_id, to_group_id, criteria, position, enabled
      FROM core.promotion_rules
      WHERE id = ${id}
      FOR UPDATE
    `) as Array<{ id: string; from_group_id: string; to_group_id: string }>;

    if (before === undefined) {
      return { ok: false, code: "not_found" } as const;
    }

    await tx`DELETE FROM core.promotion_rules WHERE id = ${id}`;
    await writeAdminLog(tx, {
      actorMemberId,
      action: "promotion.rule.delete",
      targetType: "promotion_rule",
      targetId: id,
      summary: { before },
    });
    return { ok: true } as const;
  });
}
