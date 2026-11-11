import { evaluatePromotion } from "@bulletin/db/jobs";
import { can } from "@bulletin/domain/permissions";
import {
  listReputationEntries,
  memberReputation,
  readEntry,
  recountMemberReputation,
  removeReputationEntry,
} from "@bulletin/domain/reputation";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface MemberReputationView {
  readonly memberId: string;
  readonly total: number;
  readonly entries: Awaited<ReturnType<typeof listReputationEntries>>;
}

export type MemberReputationRead =
  | { readonly ok: true; readonly view: MemberReputationView }
  | { readonly ok: false; readonly code: "not_found" | "forbidden" };

export type MemberReputationMutation =
  | { readonly ok: true; readonly total: number; readonly removedId?: string }
  | { readonly ok: false; readonly code: "not_found" | "forbidden" | "invalid" };

/** `GET /api/staff/members/<id>/reputation`: the member's total and latest entries. */
export async function readMemberReputation(
  sql: SQL,
  actorId: string,
  memberId: string,
): Promise<MemberReputationRead> {
  if (!(await can(sql, actorId, "members.reputation"))) {
    return { ok: false, code: "forbidden" };
  }

  if (!/^\d+$/.test(memberId)) {
    return { ok: false, code: "not_found" };
  }

  const [member] = (await sql`
    SELECT id::text AS id FROM core.members WHERE id = ${memberId}
  `) as Array<{ id: string }>;

  if (member === undefined) {
    return { ok: false, code: "not_found" };
  }

  return {
    ok: true,
    view: {
      memberId,
      total: await memberReputation(sql, memberId),
      entries: await listReputationEntries(sql, memberId),
    },
  };
}

/**
 * `POST /api/staff/members/<id>/reputation` with `{action: "remove", entryId}` or
 * `{action: "recount"}` (reputation spec, staff controls). Every action is logged and
 * re-evaluates the member's promotion rules because reputation is a criterion.
 */
export async function mutateMemberReputation(
  sql: SQL,
  actorId: string,
  memberId: string,
  body: unknown,
): Promise<MemberReputationMutation> {
  if (!isRecord(body) || typeof body.action !== "string" || !/^\d+$/.test(memberId)) {
    return { ok: false, code: "invalid" };
  }

  if (body.action === "recount") {
    const result = await recountMemberReputation(sql, { actorId, memberId });

    if (!result.ok) {
      return result;
    }

    await writeAdminLog(sql, {
      actorMemberId: actorId,
      action: "member.reputation.recount",
      targetType: "member",
      targetId: memberId,
      summary: { previous: result.result.previous, total: result.result.total },
    });
    await evaluatePromotion(sql, memberId).catch(() => undefined);

    return { ok: true, total: result.result.total };
  }

  if (body.action === "remove") {
    const entryId = typeof body.entryId === "string" ? body.entryId : "";

    if (!/^\d+$/.test(entryId)) {
      return { ok: false, code: "invalid" };
    }

    const entry = await readEntry(sql, entryId);

    if (entry === null || entry.receiverId !== memberId) {
      return { ok: false, code: "not_found" };
    }

    const result = await removeReputationEntry(sql, { actorId, entryId });

    if (!result.ok) {
      return result;
    }

    await writeAdminLog(sql, {
      actorMemberId: actorId,
      action: "member.reputation.remove",
      targetType: "member",
      targetId: memberId,
      summary: {
        entryId,
        points: result.result.points,
        previous: result.result.previous,
        total: result.result.total,
      },
    });
    await evaluatePromotion(sql, memberId).catch(() => undefined);

    return { ok: true, total: result.result.total, removedId: entryId };
  }

  return { ok: false, code: "invalid" };
}
