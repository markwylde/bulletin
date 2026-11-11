import { bumpCacheTags, memberTag } from "@bulletin/cache";
import type { SQL } from "bun";
import { emit } from "../events/outbox.ts";
import { runMutation } from "../mutations/index.ts";
import { reputationGiveMutation } from "../mutations/reputation.ts";
import { can } from "../permissions/can.ts";
import {
  addToReputation,
  canReadPost,
  canReceiveReputation,
  deleteStaleReactionEntries,
  listReactionReceivers,
  lockMember,
  lockReputationPost,
  memberPostCount,
  readDailyUsage,
  readEntry,
  readReactionEntry,
  readReputationRules,
  readReputationTarget,
  readVoteEntry,
  recomputeReputation,
  upsertReactionEntries,
} from "./repository.ts";

export * from "./labels.ts";
export * from "./repository.ts";

export type ReputationErrorCode =
  | "not_found"
  | "forbidden"
  | "own_post"
  | "already_given"
  | "daily_limit"
  | "negative_not_allowed"
  | "min_posts"
  | "cannot_receive";

export type ReputationOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | {
      readonly ok: false;
      readonly code: ReputationErrorCode;
      /** The daily allowance's reset time, for `daily_limit`. */
      readonly resetsAt?: Date;
      /** The board's minimum post count, for `min_posts`. */
      readonly minPosts?: number;
    };

export interface GiveReputationInput {
  readonly actorId: string;
  readonly postId: string;
  readonly points: -1 | 1;
  readonly sessionId?: string | null;
}

export interface GiveReputationResult {
  readonly receiverId: string;
  readonly entryId: string;
  readonly points: number;
  readonly total: number;
}

class ReputationRejected extends Error {
  readonly code: ReputationErrorCode;

  constructor(code: ReputationErrorCode) {
    super(`Reputation rejected: ${code}`);
    this.name = "ReputationRejected";
    this.code = code;
  }
}

function reject(code: ReputationErrorCode): never {
  throw new ReputationRejected(code);
}

function rejection(
  error: unknown,
): { readonly ok: false; readonly code: ReputationErrorCode } | null {
  return error instanceof ReputationRejected ? { ok: false, code: error.code } : null;
}

/**
 * Gives one explicit reputation point to a post's author (reputation spec): once per post,
 * inside the group's daily allowance, respecting the minimum post count, the negative
 * permission and the receiver's opt-out. The entry, the total, the `reputation.given` event
 * and the `member:{id}` bump share one transaction (ADR 0006, 0011).
 */
export async function giveReputation(
  sql: SQL,
  input: GiveReputationInput,
): Promise<ReputationOutcome<GiveReputationResult>> {
  const target = await readReputationTarget(sql, input.postId);

  if (target === null || target.visibility !== "visible") {
    return { ok: false, code: "not_found" };
  }

  const receiverId = target.authorId;

  if (receiverId === null) {
    return { ok: false, code: "not_found" };
  }

  if (!(await canReadPost(sql, input.actorId, target.forumId, input.sessionId ?? null))) {
    return { ok: false, code: "forbidden" };
  }

  if (receiverId === input.actorId) {
    return { ok: false, code: "own_post" };
  }

  const rules = await readReputationRules(sql, input.actorId);

  if (!rules.canGive) {
    return { ok: false, code: "forbidden" };
  }

  if (input.points < 0 && !rules.canGiveNegative) {
    return { ok: false, code: "negative_not_allowed" };
  }

  if ((await memberPostCount(sql, input.actorId)) < rules.minPosts) {
    return { ok: false, code: "min_posts", minPosts: rules.minPosts };
  }

  if (!(await canReceiveReputation(sql, receiverId))) {
    return { ok: false, code: "cannot_receive" };
  }

  if ((await readVoteEntry(sql, target.postId, input.actorId)) !== null) {
    return { ok: false, code: "already_given" };
  }

  const usage = await readDailyUsage(sql, input.actorId);

  if (usage.used >= rules.dailyLimit) {
    return { ok: false, code: "daily_limit", resetsAt: usage.resetsAt };
  }

  try {
    const result = await runMutation({
      sql,
      mutation: reputationGiveMutation,
      input: { receiverId },
      apply: async (tx) => {
        // Serialise votes on this post and this giver's daily allowance.
        await lockReputationPost(tx, target.postId);
        await lockMember(tx, input.actorId);

        if ((await readVoteEntry(tx, target.postId, input.actorId)) !== null) {
          reject("already_given");
        }

        const usageNow = await readDailyUsage(tx, input.actorId);

        if (usageNow.used >= rules.dailyLimit) {
          reject("daily_limit");
        }

        const [inserted] = (await tx`
          INSERT INTO core.reputation_entries (post_id, giver_id, receiver_id, points, source)
          VALUES (
            ${target.postId}, ${input.actorId}, ${receiverId}, ${input.points}, 'vote'
          )
          RETURNING id::text AS id
        `) as Array<{ id: string }>;

        if (inserted === undefined) {
          throw new Error("Giving reputation returned no entry");
        }

        const total = await addToReputation(tx, receiverId, input.points);

        await emit(tx, {
          type: "reputation.given",
          aggregateId: BigInt(receiverId),
          aggregateVersion: 1n,
          payloadIds: {
            entryId: BigInt(inserted.id),
            postId: BigInt(target.postId),
            giverId: BigInt(input.actorId),
            receiverId: BigInt(receiverId),
          },
        });

        return {
          receiverId,
          entryId: inserted.id,
          points: input.points,
          total,
        };
      },
    });

    return { ok: true, result };
  } catch (error) {
    if (error instanceof ReputationRejected && error.code === "daily_limit") {
      return {
        ok: false,
        code: "daily_limit",
        resetsAt: (await readDailyUsage(sql, input.actorId)).resetsAt,
      };
    }

    const failure = rejection(error);

    if (failure === null) {
      throw error;
    }

    return failure;
  }
}

export interface ReactionReputationInput {
  readonly postId: string;
  readonly giverId: string;
  readonly receiverId: string;
  /** The chosen reaction's weight, or 0 when it has none. */
  readonly points: -1 | 0 | 1;
}

export interface ReactionReputationResult {
  readonly total: number;
  readonly changed: boolean;
}

/**
 * The reaction-to-reputation link (design): upserts (or removes) the reaction-sourced entry in
 * the caller's transaction. A receiver whose groups opt out gets no entry.
 */
export async function applyReactionReputation(
  tx: SQL,
  input: ReactionReputationInput,
): Promise<ReactionReputationResult> {
  const existing = await readReactionEntry(tx, input.postId, input.giverId);
  const receiving = await canReceiveReputation(tx, input.receiverId);
  const wanted = input.points !== 0 && receiving ? input.points : 0;

  if (wanted === 0) {
    if (existing !== null) {
      await tx`DELETE FROM core.reputation_entries WHERE id = ${existing.id}`;
    }

    const total = await addToReputation(
      tx,
      input.receiverId,
      existing === null ? 0 : -existing.points,
    );

    return { total, changed: existing !== null };
  }

  await tx`
    INSERT INTO core.reputation_entries (post_id, giver_id, receiver_id, points, source)
    VALUES (${input.postId}, ${input.giverId}, ${input.receiverId}, ${wanted}, 'reaction')
    ON CONFLICT (post_id, giver_id, source) DO UPDATE
      SET points = EXCLUDED.points, receiver_id = EXCLUDED.receiver_id
  `;

  const delta = wanted - (existing?.points ?? 0);
  const total = await addToReputation(tx, input.receiverId, delta);

  return { total, changed: delta !== 0 };
}

/** Removes one entry (staff, `members.reputation`) and recounts the receiver immediately. */
export async function removeReputationEntry(
  sql: SQL,
  input: { readonly actorId: string; readonly entryId: string },
): Promise<
  | {
      readonly ok: true;
      readonly result: {
        readonly receiverId: string;
        readonly previous: number;
        readonly total: number;
        readonly points: number;
      };
    }
  | { readonly ok: false; readonly code: "not_found" | "forbidden" }
> {
  if (!(await can(sql, input.actorId, "members.reputation"))) {
    return { ok: false, code: "forbidden" };
  }

  const entry = await readEntry(sql, input.entryId);

  if (entry === null) {
    return { ok: false, code: "not_found" };
  }

  return sql.begin(async (tx) => {
    await lockMember(tx, entry.receiverId);
    await tx`DELETE FROM core.reputation_entries WHERE id = ${entry.id}`;
    const recounted = await recomputeReputation(tx, entry.receiverId);

    if (recounted === null) {
      throw new Error(`Could not recount member ${entry.receiverId}`);
    }

    if (recounted.previous !== recounted.total) {
      await bumpCacheTags(tx, [memberTag(entry.receiverId)]);
    }

    return {
      ok: true as const,
      result: {
        receiverId: entry.receiverId,
        previous: recounted.previous,
        total: recounted.total,
        points: entry.points,
      },
    };
  });
}

export interface RecountResult {
  readonly memberId: string;
  readonly previous: number;
  readonly total: number;
  readonly changed: boolean;
}

/** Staff recount of one member: `SUM(points)` over their entries, bumping only the card. */
export async function recountMemberReputation(
  sql: SQL,
  input: { readonly actorId: string; readonly memberId: string },
): Promise<
  | { readonly ok: true; readonly result: RecountResult }
  | { readonly ok: false; readonly code: "forbidden" | "not_found" }
> {
  if (!(await can(sql, input.actorId, "members.reputation"))) {
    return { ok: false, code: "forbidden" };
  }

  return sql.begin(async (tx) => {
    const recounted = await recomputeReputation(tx, input.memberId);

    if (recounted === null) {
      return { ok: false as const, code: "not_found" as const };
    }

    if (recounted.previous !== recounted.total) {
      await bumpCacheTags(tx, [memberTag(input.memberId)]);
    }

    return {
      ok: true as const,
      result: {
        memberId: input.memberId,
        previous: recounted.previous,
        total: recounted.total,
        changed: recounted.previous !== recounted.total,
      },
    };
  });
}

/** Rebuilds reaction entries, routing each receiver's opt-out through `can()` (ADR 0005). */
export async function rebuildReactionEntries(tx: SQL): Promise<void> {
  const receivers = await listReactionReceivers(tx);
  const allowed: string[] = [];

  for (const receiverId of receivers) {
    if (await can(tx, receiverId, "receive_reputation")) {
      allowed.push(receiverId);
    }
  }

  await deleteStaleReactionEntries(tx, allowed);
  await upsertReactionEntries(tx, allowed);
}
