import {
  deleteReaction,
  listReactions,
  parseReactionInput,
  type ReactionAdminOutcome,
  reorderReaction,
  saveReaction,
} from "@bulletin/domain/reactions";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface StaffReactionView {
  readonly id: string;
  readonly key: string;
  readonly icon: string;
  readonly labelKey: string;
  readonly weight: -1 | 0 | 1;
  readonly position: number;
  readonly enabled: boolean;
}

/** `GET /api/staff/reactions`: the whole set, disabled entries included. */
export async function listReactionsForStaff(
  sql: SQL,
): Promise<{ readonly reactions: readonly StaffReactionView[] }> {
  return { reactions: await listReactions(sql) };
}

/**
 * `POST /api/staff/reactions` with `{action: "save" | "delete" | "move"}` (reactions spec,
 * staff reaction set). Every write is logged with the actor (ADR 0012).
 */
export async function mutateReaction(
  sql: SQL,
  actorMemberId: string,
  body: unknown,
): Promise<ReactionAdminOutcome> {
  if (!isRecord(body) || typeof body.action !== "string") {
    return { ok: false, code: "invalid" };
  }

  switch (body.action) {
    case "save": {
      const input = parseReactionInput(body.reaction);

      if (input === null) {
        return { ok: false, code: "invalid" };
      }

      const result = await saveReaction(sql, input);

      if (result.ok) {
        await writeAdminLog(sql, {
          actorMemberId,
          action: input.id === undefined ? "reaction.create" : "reaction.update",
          targetType: "reaction",
          targetId: result.reactionId,
          summary: {
            key: input.key,
            icon: input.icon,
            labelKey: input.labelKey,
            weight: input.weight,
            position: input.position,
            enabled: input.enabled,
          },
        });
      }

      return result;
    }
    case "delete": {
      const id = typeof body.id === "string" ? body.id : "";
      const result = await deleteReaction(sql, id);

      if (result.ok) {
        await writeAdminLog(sql, {
          actorMemberId,
          action: "reaction.delete",
          targetType: "reaction",
          targetId: id,
          summary: { id },
        });
      }

      return result;
    }
    case "move": {
      const id = typeof body.id === "string" ? body.id : "";
      const direction =
        body.direction === "up" || body.direction === "down" ? body.direction : null;

      if (direction === null) {
        return { ok: false, code: "invalid" };
      }

      const result = await reorderReaction(sql, id, direction);

      if (result.ok) {
        await writeAdminLog(sql, {
          actorMemberId,
          action: "reaction.reorder",
          targetType: "reaction",
          targetId: id,
          summary: { direction },
        });
      }

      return result;
    }
    default:
      return { ok: false, code: "invalid" };
  }
}
