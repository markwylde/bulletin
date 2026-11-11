import type { SQL } from "bun";
import { emit } from "../events/outbox.ts";
import { runMutation } from "../mutations/index.ts";
import { reactionAdminMutation, reactionSetMutation } from "../mutations/reactions.ts";
import {
  canReactInForum,
  listReactions,
  lockReactionPost,
  type ReactionRecord,
  type ReactionSummary,
  readMemberReaction,
  readReactionSummary,
  readReactionTarget,
  recomputeReactionSummary,
} from "./repository.ts";

export * from "./repository.ts";

/** The shipped labels a reaction may use; every one exists in en, es and fr (ADR 0013). */
export const REACTION_LABEL_KEYS = [
  "reaction.label.like",
  "reaction.label.thanks",
  "reaction.label.love",
  "reaction.label.laugh",
  "reaction.label.wow",
  "reaction.label.sad",
  "reaction.label.confused",
  "reaction.label.angry",
] as const;

export type ReactionLabelKey = (typeof REACTION_LABEL_KEYS)[number];

export type ReactionErrorCode =
  | "not_found"
  | "forbidden"
  | "own_post"
  | "invalid_reaction"
  | "reaction_disabled";

export type ReactionOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly code: ReactionErrorCode };

export interface SetReactionResult {
  readonly postId: string;
  readonly mine: string | null;
  readonly summary: ReactionSummary;
}

export interface SetReactionInput {
  readonly actorId: string;
  readonly postId: string;
  /** `null` removes the member's reaction from the post. */
  readonly reactionId: string | null;
  readonly sessionId?: string | null;
}

class ReactionRejected extends Error {
  readonly code: ReactionErrorCode;

  constructor(code: ReactionErrorCode) {
    super(`Reaction rejected: ${code}`);
    this.name = "ReactionRejected";
    this.code = code;
  }
}

function reject(code: ReactionErrorCode): never {
  throw new ReactionRejected(code);
}

function rejected(error: unknown): ReactionRejected | null {
  return error instanceof ReactionRejected ? error : null;
}

/**
 * Adds, changes or removes the actor's one reaction on a post (reactions spec). Own posts are
 * rejected before the write; the summary and the `reaction.added` event share the transaction
 * with the reaction itself (ADR 0006, 0011).
 */
export async function setReaction(
  sql: SQL,
  input: SetReactionInput,
): Promise<ReactionOutcome<SetReactionResult>> {
  const target = await readReactionTarget(sql, input.postId);

  if (target === null || target.visibility !== "visible") {
    return { ok: false, code: "not_found" };
  }

  const allowed = await canReactInForum(
    sql,
    input.actorId,
    target.forumId,
    input.sessionId ?? null,
  );

  if (!allowed) {
    return { ok: false, code: "forbidden" };
  }

  if (target.authorId === input.actorId) {
    return { ok: false, code: "own_post" };
  }

  if (input.reactionId !== null) {
    const chosen = (await listReactions(sql)).find((reaction) => reaction.id === input.reactionId);

    if (chosen === undefined) {
      return { ok: false, code: "invalid_reaction" };
    }

    if (!chosen.enabled) {
      return { ok: false, code: "reaction_disabled" };
    }
  }

  const current = await readMemberReaction(sql, target.postId, input.actorId);

  if (current === input.reactionId) {
    return {
      ok: true,
      result: {
        postId: target.postId,
        mine: current,
        summary: await readReactionSummary(sql, target.postId),
      },
    };
  }

  try {
    const result = await runMutation({
      sql,
      mutation: reactionSetMutation,
      input: { postId: target.postId },
      apply: async (tx) => {
        // Serialise concurrent reactions on this post so the summary cannot lose an update.
        await lockReactionPost(tx, target.postId);

        if (input.reactionId !== null) {
          // A staff edit may have disabled or removed the reaction since the pre-read.
          const [reaction] = (await tx`
            SELECT enabled FROM core.reactions WHERE id = ${input.reactionId}
          `) as Array<{ enabled: boolean }>;

          if (reaction === undefined) {
            reject("invalid_reaction");
          }

          if (!reaction.enabled) {
            reject("reaction_disabled");
          }

          await tx`
            INSERT INTO core.post_reactions (post_id, member_id, reaction_id)
            VALUES (${target.postId}, ${input.actorId}, ${input.reactionId})
            ON CONFLICT (post_id, member_id) DO UPDATE
              SET reaction_id = EXCLUDED.reaction_id, created_at = now()
          `;
          await emit(tx, {
            type: "reaction.added",
            aggregateId: BigInt(target.postId),
            aggregateVersion: 1n,
            payloadIds: {
              reactionId: BigInt(input.reactionId),
              postId: BigInt(target.postId),
              topicId: BigInt(target.topicId),
              memberId: BigInt(input.actorId),
            },
          });
        } else {
          await tx`
            DELETE FROM core.post_reactions
            WHERE post_id = ${target.postId} AND member_id = ${input.actorId}
          `;
        }

        return {
          postId: target.postId,
          mine: input.reactionId,
          summary: await recomputeReactionSummary(tx, target.postId),
        };
      },
    });

    return { ok: true, result };
  } catch (error) {
    const failure = rejected(error);

    return failure === null ? Promise.reject(error) : { ok: false, code: failure.code };
  }
}

// ---------------------------------------------------------------------------------------------
// Staff reaction set
// ---------------------------------------------------------------------------------------------

export interface ReactionInput {
  readonly id?: string;
  readonly key: string;
  readonly icon: string;
  readonly labelKey: ReactionLabelKey;
  readonly weight: -1 | 0 | 1;
  readonly position: number;
  readonly enabled: boolean;
}

export type ReactionAdminOutcome =
  | { readonly ok: true; readonly reactionId: string }
  | {
      readonly ok: false;
      readonly code: "invalid" | "not_found" | "duplicate_key" | "in_use";
    };

const REACTION_KEY = /^[a-z][a-z0-9_]{0,31}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReactionLabelKey(value: string): value is ReactionLabelKey {
  return (REACTION_LABEL_KEYS as readonly string[]).includes(value);
}

function reactionWeight(value: unknown): -1 | 0 | 1 | null {
  return value === -1 || value === 0 || value === 1 ? value : null;
}

/** Parses one staff reaction form; the label must be a shipped, translated key (ADR 0013). */
export function parseReactionInput(value: unknown): ReactionInput | null {
  if (!isRecord(value)) {
    return null;
  }

  const key = typeof value.key === "string" ? value.key.trim() : "";
  const icon = typeof value.icon === "string" ? value.icon.trim() : "";
  const labelKey = typeof value.labelKey === "string" ? value.labelKey : "";
  const weight = reactionWeight(value.weight);
  const position = value.position;
  const enabled = value.enabled;
  const id = typeof value.id === "string" && /^\d+$/.test(value.id) ? value.id : undefined;

  if (
    !REACTION_KEY.test(key) ||
    icon.length < 1 ||
    icon.length > 32 ||
    !isReactionLabelKey(labelKey) ||
    weight === null ||
    typeof position !== "number" ||
    !Number.isInteger(position) ||
    position < 0 ||
    position > 1_000 ||
    typeof enabled !== "boolean"
  ) {
    return null;
  }

  return {
    ...(id === undefined ? {} : { id }),
    key,
    icon,
    labelKey,
    weight,
    position,
    enabled,
  };
}

/** Bun reports SQLSTATE on `errno`; `code` is the driver's own error name. */
function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const record = error as { readonly errno?: unknown; readonly code?: unknown };

  return typeof record.errno === "string"
    ? record.errno
    : typeof record.code === "string"
      ? record.code
      : null;
}

export async function saveReaction(sql: SQL, input: ReactionInput): Promise<ReactionAdminOutcome> {
  try {
    const result = await runMutation({
      sql,
      mutation: reactionAdminMutation,
      input: { action: input.id === undefined ? "create" : "update" },
      apply: async (tx) => {
        if (input.id !== undefined) {
          const [updated] = (await tx`
            UPDATE core.reactions
            SET key = ${input.key},
                icon = ${input.icon},
                label_key = ${input.labelKey},
                weight = ${input.weight},
                position = ${input.position},
                enabled = ${input.enabled},
                updated_at = now()
            WHERE id = ${input.id}
            RETURNING id::text AS id
          `) as Array<{ id: string }>;

          if (updated === undefined) {
            reject("not_found");
          }

          return { reactionId: updated.id };
        }

        const [saved] = (await tx`
          INSERT INTO core.reactions (key, icon, label_key, weight, position, enabled)
          VALUES (
            ${input.key}, ${input.icon}, ${input.labelKey}, ${input.weight},
            ${input.position}, ${input.enabled}
          )
          ON CONFLICT (key) DO UPDATE
            SET icon = EXCLUDED.icon,
                label_key = EXCLUDED.label_key,
                weight = EXCLUDED.weight,
                position = EXCLUDED.position,
                enabled = EXCLUDED.enabled,
                updated_at = now()
          RETURNING id::text AS id
        `) as Array<{ id: string }>;

        if (saved === undefined) {
          throw new Error("Saving a reaction returned no row");
        }

        return { reactionId: saved.id };
      },
    });

    return { ok: true, reactionId: result.reactionId };
  } catch (error) {
    if (errorCode(error) === "23505") {
      return { ok: false, code: "duplicate_key" };
    }

    if (rejected(error)?.code === "not_found") {
      return { ok: false, code: "not_found" };
    }

    throw error;
  }
}

export async function reorderReaction(
  sql: SQL,
  reactionId: string,
  direction: "up" | "down",
): Promise<ReactionAdminOutcome> {
  try {
    const result = await runMutation({
      sql,
      mutation: reactionAdminMutation,
      input: { action: `reorder-${direction}` },
      apply: async (tx) => {
        const rows = (await tx`
          SELECT id::text AS id, position
          FROM core.reactions
          ORDER BY position, id
          FOR UPDATE
        `) as Array<{ id: string; position: number }>;
        const index = rows.findIndex((row) => row.id === reactionId);
        const neighbourIndex = direction === "up" ? index - 1 : index + 1;

        if (index === -1) {
          reject("not_found");
        }

        const current = rows[index];
        const neighbour = rows[neighbourIndex];

        if (current === undefined) {
          reject("not_found");
        }

        // Already first or last: nothing moves, but the response is still a success.
        if (neighbour === undefined) {
          return { reactionId };
        }

        await tx`
          UPDATE core.reactions
          SET position = CASE WHEN id = ${current.id} THEN ${neighbour.position}
                              ELSE ${current.position} END,
              updated_at = now()
          WHERE id IN (${current.id}, ${neighbour.id})
        `;

        return { reactionId };
      },
    });

    return { ok: true, reactionId: result.reactionId };
  } catch (error) {
    if (rejected(error)?.code === "not_found") {
      return { ok: false, code: "not_found" };
    }

    throw error;
  }
}

export async function deleteReaction(sql: SQL, reactionId: string): Promise<ReactionAdminOutcome> {
  try {
    await runMutation({
      sql,
      mutation: reactionAdminMutation,
      input: { action: "delete" },
      apply: async (tx) => {
        const [deleted] = (await tx`
          DELETE FROM core.reactions WHERE id = ${reactionId} RETURNING id::text AS id
        `) as Array<{ id: string }>;

        if (deleted === undefined) {
          reject("not_found");
        }

        return { reactionId: deleted.id };
      },
    });

    return { ok: true, reactionId };
  } catch (error) {
    if (errorCode(error) === "23001" || errorCode(error) === "23503") {
      return { ok: false, code: "in_use" };
    }

    if (rejected(error)?.code === "not_found") {
      return { ok: false, code: "not_found" };
    }

    throw error;
  }
}

export type { ReactionRecord };
