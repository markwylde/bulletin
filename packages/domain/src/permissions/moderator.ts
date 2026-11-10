import { MODERATOR_POWERS, type ModeratorPower, moderatorSettingKey } from "./actions.ts";
import type { MergedGroupSettings } from "./registry.ts";
import type { ForumTree } from "./tree.ts";

export interface ModeratorAssignment {
  readonly forumId: string;
  readonly memberId: string | null;
  readonly groupId: string | null;
  readonly powers: readonly ModeratorPower[];
  /** When true the assignment does not reach sub-forums (ADR 0005). */
  readonly thisForumOnly: boolean;
}

export interface ModeratorContext {
  readonly memberId: string;
  readonly groupIds: readonly string[];
  readonly banned: boolean;
  readonly globalPowers: ReadonlySet<ModeratorPower>;
  readonly assignments: readonly ModeratorAssignment[];
  readonly tree: ForumTree;
}

/** The powers a group setting grants globally, i.e. super-moderator powers. */
export function globalModeratorPowers(merged: MergedGroupSettings): ReadonlySet<ModeratorPower> {
  const powers = new Set<ModeratorPower>();

  for (const power of MODERATOR_POWERS) {
    if (merged[moderatorSettingKey(power)] === true) {
      powers.add(power);
    }
  }

  return powers;
}

function assignmentAppliesTo(
  context: ModeratorContext,
  assignment: ModeratorAssignment,
  forumId: string,
  lineage: ReadonlySet<string>,
): boolean {
  const assigneeMatches =
    assignment.memberId === context.memberId ||
    (assignment.groupId !== null && context.groupIds.includes(assignment.groupId));

  if (!assigneeMatches) {
    return false;
  }

  return assignment.thisForumOnly
    ? assignment.forumId === forumId
    : lineage.has(assignment.forumId);
}

/**
 * The TypeScript reference for `core.has_mod_power` (ADR 0005): banned members have no powers,
 * group super-moderator settings grant a power on every forum, and member or group assignments
 * reach sub-forums unless they are "this forum only".
 */
export function moderatorPowerAllowed(
  context: ModeratorContext,
  forumId: string,
  power: ModeratorPower,
): boolean {
  if (context.tree.get(forumId) === undefined || context.banned) {
    return false;
  }

  if (context.globalPowers.has(power)) {
    return true;
  }

  const lineage = new Set(context.tree.lineage(forumId).map((node) => node.id));

  return context.assignments.some(
    (assignment) =>
      assignment.powers.includes(power) &&
      assignmentAppliesTo(context, assignment, forumId, lineage),
  );
}
