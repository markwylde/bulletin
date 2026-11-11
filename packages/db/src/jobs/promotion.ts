import type { Logger } from "@bulletin/config";
import { emit, toBigInt } from "@bulletin/domain/events";
import {
  promotionCriteria as defaultPromotionCriteria,
  type PromotionCriteriaRegistry,
} from "@bulletin/domain/permissions";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";

export const PROMOTION_EVALUATE_QUEUE = "promotion.evaluate";
export const PROMOTION_NIGHTLY_QUEUE = "promotion.nightly";
export const PROMOTION_NIGHTLY_CRON = "0 3 * * *";

export type PromotionResult =
  | {
      readonly kind: "promoted";
      readonly memberId: string;
      readonly fromGroupId: string;
      readonly toGroupId: string;
      readonly ruleId: string;
      readonly aggregateVersion: bigint;
    }
  | { readonly kind: "none" }
  | { readonly kind: "missing" };

export interface EvaluatePromotionOptions {
  readonly criteria?: PromotionCriteriaRegistry;
  readonly now?: Date;
}

interface MemberLockRow {
  readonly id: string;
}

interface PrimaryGroupRow {
  readonly group_id: string;
}

interface PromotionRuleRow {
  readonly id: string;
  readonly from_group_id: string;
  readonly to_group_id: string;
  readonly criteria: unknown;
  readonly position: number;
}

function parseCriteria(value: unknown): Readonly<Record<string, number>> | null {
  let parsed: unknown = value;

  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const criteria: Record<string, number> = {};

  for (const [key, raw] of Object.entries(parsed)) {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      return null;
    }

    criteria[key] = raw;
  }

  return criteria;
}

async function ruleMatches(
  tx: SQL,
  rule: PromotionRuleRow,
  memberId: string,
  criteria: PromotionCriteriaRegistry,
  now: Date,
): Promise<boolean> {
  const thresholds = parseCriteria(rule.criteria);

  if (thresholds === null) {
    return false;
  }

  for (const [key, threshold] of Object.entries(thresholds)) {
    const criterion = criteria.get(key);

    // A rule with a criterion this process does not know must never promote anyone.
    if (criterion === undefined) {
      return false;
    }

    const value = await criterion.read({ sql: tx, memberId, now });

    if (!Number.isFinite(value) || value < threshold) {
      return false;
    }
  }

  return true;
}

/**
 * Evaluates the ordered promotion rules for one member (ADR 0005).
 *
 * The member row is locked with `SELECT … FOR UPDATE`, so two concurrent evaluations apply at
 * most one promotion. The primary group moves to the first matching rule's target, and the
 * `member.promoted` event is committed in the same transaction (ADR 0011).
 */
export async function evaluatePromotion(
  sql: SQL,
  memberId: string,
  options: EvaluatePromotionOptions = {},
): Promise<PromotionResult> {
  const now = options.now ?? new Date();
  const criteria = options.criteria ?? defaultPromotionCriteria;

  return sql.begin(async (tx) => {
    const [member] = (await tx`
      SELECT id
      FROM core.members
      WHERE id = ${memberId}
      FOR UPDATE
    `) as MemberLockRow[];

    if (member === undefined) {
      return { kind: "missing" } as const;
    }

    // A separate statement sees the committed state after a concurrent evaluation releases the
    // lock, even though the locking SELECT's snapshot predates it.
    const [primary] = (await tx`
      SELECT group_id
      FROM core.member_groups
      WHERE member_id = ${memberId} AND is_primary
    `) as PrimaryGroupRow[];

    if (primary === undefined) {
      return { kind: "none" } as const;
    }

    const rules = (await tx`
      SELECT id, from_group_id, to_group_id, criteria, position
      FROM core.promotion_rules
      WHERE enabled
        AND from_group_id = ${primary.group_id}
      ORDER BY position, id
    `) as PromotionRuleRow[];

    for (const rule of rules) {
      if (!(await ruleMatches(tx, rule, memberId, criteria, now))) {
        continue;
      }

      // Move the primary membership; remove a secondary row for the target first so the move
      // cannot violate the (member, group) primary key.
      await tx`
        DELETE FROM core.member_groups
        WHERE member_id = ${memberId}
          AND group_id = ${rule.to_group_id}
          AND NOT is_primary
      `;

      const moved = (await tx`
        UPDATE core.member_groups
        SET group_id = ${rule.to_group_id}
        WHERE member_id = ${memberId}
          AND is_primary
        RETURNING 1
      `) as unknown[];

      if (moved.length === 0) {
        await tx`
          INSERT INTO core.member_groups (member_id, group_id, is_primary)
          VALUES (${memberId}, ${rule.to_group_id}, true)
          ON CONFLICT (member_id, group_id) DO UPDATE SET is_primary = true
        `;
      }

      const [version] = (await tx`
        UPDATE core.members
        SET promotion_version = promotion_version + 1
        WHERE id = ${memberId}
        RETURNING promotion_version
      `) as Array<{ promotion_version: string }>;

      if (version === undefined) {
        throw new Error(`Could not version the promotion of member ${memberId}`);
      }

      const aggregateVersion = toBigInt(version.promotion_version);

      await emit(tx, {
        type: "member.promoted",
        aggregateId: toBigInt(memberId),
        aggregateVersion,
        payloadIds: {
          memberId: toBigInt(memberId),
          fromGroupId: toBigInt(rule.from_group_id),
          toGroupId: toBigInt(rule.to_group_id),
          ruleId: toBigInt(rule.id),
        },
      });

      return {
        kind: "promoted",
        memberId,
        fromGroupId: rule.from_group_id,
        toGroupId: rule.to_group_id,
        ruleId: rule.id,
        aggregateVersion,
      } as const;
    }

    return { kind: "none" } as const;
  });
}

/** Members whose current primary group is the source of at least one enabled rule. */
export async function listPromotionCandidates(sql: SQL): Promise<readonly string[]> {
  const rows = (await sql`
    SELECT DISTINCT m.id
    FROM core.members m
    JOIN core.member_groups mg ON mg.member_id = m.id AND mg.is_primary
    JOIN core.promotion_rules r ON r.from_group_id = mg.group_id AND r.enabled
    ORDER BY m.id
  `) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

/** The nightly sweep enqueues one evaluation per candidate; returns how many were enqueued. */
export async function runNightlyPromotionSweep(
  sql: SQL,
  enqueue: (memberId: string) => Promise<void>,
): Promise<number> {
  const candidates = await listPromotionCandidates(sql);

  for (const memberId of candidates) {
    await enqueue(memberId);
  }

  return candidates.length;
}

export interface PromotionJobPayload {
  readonly memberId: string;
}

export interface PromotionJobsOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  readonly logger?: Logger;
  readonly criteria?: PromotionCriteriaRegistry;
  readonly now?: () => Date;
}

export interface PromotionJobs {
  stop(): Promise<void>;
}

/**
 * The promotion queue and its nightly schedule (ADR 0011). Job payloads carry only the member
 * ID; the worker loads the current state inside the row-locked transaction.
 */
export async function createPromotionJobs(options: PromotionJobsOptions): Promise<PromotionJobs> {
  const criteria = options.criteria ?? defaultPromotionCriteria;
  const now = options.now ?? (() => new Date());

  await ensurePgBossQueue(options.boss, PROMOTION_EVALUATE_QUEUE);
  await ensurePgBossQueue(options.boss, PROMOTION_NIGHTLY_QUEUE);

  await options.boss.work<PromotionJobPayload>(PROMOTION_EVALUATE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      try {
        const result = await evaluatePromotion(options.sql, job.data.memberId, {
          criteria,
          now: now(),
        });
        options.logger?.info("promotion.evaluated", {
          memberId: job.data.memberId,
          result: result.kind,
        });
      } catch (error) {
        options.logger?.error("promotion.evaluate.failed", {
          memberId: job.data.memberId,
          error,
        });
        throw error;
      }
    }
  });

  await options.boss.work(PROMOTION_NIGHTLY_QUEUE, async () => {
    const candidates = await runNightlyPromotionSweep(options.sql, async (memberId) => {
      await options.boss.send(
        PROMOTION_EVALUATE_QUEUE,
        { memberId },
        { singletonKey: `promotion:${memberId}` },
      );
    });
    options.logger?.info("promotion.nightly.completed", { candidates });
  });

  await options.boss.schedule(PROMOTION_NIGHTLY_QUEUE, PROMOTION_NIGHTLY_CRON, {});

  return {
    async stop() {
      await options.boss.offWork(PROMOTION_EVALUATE_QUEUE);
      await options.boss.offWork(PROMOTION_NIGHTLY_QUEUE);
    },
  };
}
