import { describe, expect, test } from "bun:test";
import {
  capabilityBitMask,
  FORUM_ACTIONS,
  type ForumAction,
  forumActionMask,
  hasCapabilityBit,
  MODERATOR_POWERS,
  type ModeratorPower,
} from "./actions.ts";
import type { ModeratorAssignment } from "./moderator.ts";
import {
  type CompiledGroupSnapshot,
  capabilityAnswer,
  compileGroupSnapshot,
  compileMemberSnapshot,
  type ForumMatrixRow,
  type PermissionData,
  type PermissionSnapshot,
} from "./snapshot.ts";
import { createForumTree, type ForumNode, type ForumTree } from "./tree.ts";

const SHOW = capabilityBitMask("show");
const READ = capabilityBitMask("read");

/** Small deterministic PRNG so property failures reproduce. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  const value = values[Math.floor(rng() * values.length)];

  if (value === undefined) {
    throw new Error("Cannot pick from an empty list");
  }

  return value;
}

function randomTree(rng: () => number, size: number): ForumTree {
  const nodes: ForumNode[] = [{ id: "1", parentId: null, passwordProtected: false }];

  for (let index = 2; index <= size; index += 1) {
    const parent = pick(rng, nodes);
    nodes.push({
      id: String(index),
      parentId: parent.id,
      passwordProtected: false,
    });
  }

  return createForumTree(nodes);
}

function randomData(rng: () => number): {
  readonly data: PermissionData;
  readonly groupIds: readonly string[];
  readonly assignments: readonly ModeratorAssignment[];
  readonly memberId: string;
} {
  const tree = randomTree(rng, 3 + Math.floor(rng() * 6));
  const groupIds = ["1", "2", "3", "4", "5"].filter(() => rng() < 0.55);

  if (groupIds.length === 0) {
    groupIds.push("1");
  }

  const maskIds = ["10", "11", "12", "13"];
  const masksByGroup = new Map<string, string[]>();

  for (const groupId of ["1", "2", "3", "4", "5"]) {
    const masks = maskIds.filter(() => rng() < 0.5);

    if (masks.length > 0) {
      masksByGroup.set(groupId, masks);
    }
  }

  const matrix: ForumMatrixRow[] = [];

  for (const forumId of tree.ids) {
    for (const maskId of maskIds) {
      if (rng() < 0.55) {
        const actions = FORUM_ACTIONS.filter(() => rng() < 0.5);
        matrix.push({
          forumId,
          maskId,
          actions: forumActionMask(actions),
          inherits: rng() < 0.35,
        });
      }
    }
  }

  const globalPowersByGroup = new Map<string, ModeratorPower[]>();

  for (const groupId of ["1", "2", "3"]) {
    const powers = MODERATOR_POWERS.filter(() => rng() < 0.08);

    if (powers.length > 0) {
      globalPowersByGroup.set(groupId, powers);
    }
  }

  const assignments: ModeratorAssignment[] = [];

  for (let index = 0; index < 3; index += 1) {
    if (rng() < 0.35) {
      continue;
    }

    const useMember = rng() < 0.5;
    assignments.push({
      forumId: pick(rng, tree.ids),
      memberId: useMember ? "1" : null,
      groupId: useMember ? null : pick(rng, groupIds),
      powers: MODERATOR_POWERS.filter(() => rng() < 0.2),
      thisForumOnly: rng() < 0.3,
    });
  }

  return {
    data: { tree, masksByGroup, matrix, globalPowersByGroup },
    groupIds,
    assignments,
    memberId: "1",
  };
}

function masksFor(data: PermissionData, groupIds: readonly string[]): readonly string[] {
  const masks = new Set<string>();

  for (const groupId of groupIds) {
    for (const maskId of data.masksByGroup.get(groupId) ?? []) {
      masks.add(maskId);
    }
  }

  return [...masks];
}

/** Naive translation of ADR 0005, written without the compiler's caches. */
function referenceResolve(data: PermissionData, forumId: string, maskId: string): number {
  let actions = 0;

  for (const node of data.tree.lineage(forumId)) {
    const row = data.matrix.find(
      (candidate) => candidate.forumId === node.id && candidate.maskId === maskId,
    );

    if (row !== undefined) {
      actions = row.inherits ? actions : row.actions;
    }
  }

  return actions;
}

function referenceNodeActions(
  data: PermissionData,
  groupIds: readonly string[],
  forumId: string,
): number {
  let actions = 0;

  for (const maskId of masksFor(data, groupIds)) {
    actions |= referenceResolve(data, forumId, maskId);
  }

  if ((actions & READ) !== 0) {
    actions |= SHOW;
  }

  return actions;
}

function referenceAction(
  data: PermissionData,
  groupIds: readonly string[],
  forumId: string,
  action: ForumAction,
): boolean {
  const actionBits = referenceNodeActions(data, groupIds, forumId);

  if (
    !data.tree
      .lineage(forumId)
      .every((node) => (referenceNodeActions(data, groupIds, node.id) & SHOW) !== 0)
  ) {
    return false;
  }

  return (actionBits & capabilityBitMask(action)) !== 0;
}

function assignmentApplies(
  data: PermissionData,
  assignment: ModeratorAssignment,
  forumId: string,
): boolean {
  if (assignment.thisForumOnly) {
    return assignment.forumId === forumId;
  }

  return data.tree.lineage(forumId).some((node) => node.id === assignment.forumId);
}

function referencePower(
  data: PermissionData,
  groupIds: readonly string[],
  assignments: readonly ModeratorAssignment[],
  forumId: string,
  power: ModeratorPower,
): boolean {
  if (!referenceAction(data, groupIds, forumId, "read")) {
    return false;
  }

  if (groupIds.some((groupId) => data.globalPowersByGroup.get(groupId)?.includes(power))) {
    return true;
  }

  return assignments.some(
    (assignment) =>
      assignment.powers.includes(power) && assignmentApplies(data, assignment, forumId),
  );
}

function compiled(
  data: PermissionData,
  groupIds: readonly string[],
  assignments: readonly ModeratorAssignment[],
): {
  readonly group: CompiledGroupSnapshot;
  readonly snapshot: PermissionSnapshot;
} {
  const group = compileGroupSnapshot(data, groupIds);
  const loaded = compileMemberSnapshot({
    groupSnapshot: group,
    assignments,
    tree: data.tree,
    memberId: "1",
    groupIds,
    primaryGroupId: groupIds[0] ?? null,
    settings: {},
    banned: false,
  });

  return { group, snapshot: { ...loaded, unlocked: new Set() } };
}

describe("snapshot compilation property tests", () => {
  test("matches the naive reference over random trees, masks and group sets", () => {
    const rng = seeded(20261110);

    for (let iteration = 0; iteration < 60; iteration += 1) {
      const input = randomData(rng);
      const { snapshot } = compiled(input.data, input.groupIds, input.assignments);

      for (const forumId of input.data.tree.ids) {
        for (const action of FORUM_ACTIONS) {
          expect({
            iteration,
            forumId,
            action,
            allowed: capabilityAnswer(snapshot, forumId, action),
          }).toEqual({
            iteration,
            forumId,
            action,
            allowed: referenceAction(input.data, input.groupIds, forumId, action),
          });
        }

        for (const power of MODERATOR_POWERS) {
          expect({
            iteration,
            forumId,
            power,
            allowed: capabilityAnswer(snapshot, forumId, power),
          }).toEqual({
            iteration,
            forumId,
            power,
            allowed: referencePower(input.data, input.groupIds, input.assignments, forumId, power),
          });
        }
      }
    }
  });

  test("read implies show even when the mask grants only read", () => {
    const tree = createForumTree([{ id: "1", parentId: null, passwordProtected: false }]);
    const data: PermissionData = {
      tree,
      masksByGroup: new Map([["1", ["10"]]]),
      matrix: [
        {
          forumId: "1",
          maskId: "10",
          actions: capabilityBitMask("read"),
          inherits: false,
        },
      ],
      globalPowersByGroup: new Map(),
    };
    const group = compileGroupSnapshot(data, ["1"]);

    expect(hasCapabilityBit(group.bits.get("1") ?? 0, "show")).toBe(true);
    expect(hasCapabilityBit(group.bits.get("1") ?? 0, "read")).toBe(true);
  });

  test("a root row marked inherits=true resolves to zero", () => {
    const tree = createForumTree([{ id: "1", parentId: null, passwordProtected: false }]);
    const data: PermissionData = {
      tree,
      masksByGroup: new Map([["1", ["10"]]]),
      matrix: [
        {
          forumId: "1",
          maskId: "10",
          actions: forumActionMask(["show", "read"]),
          inherits: true,
        },
      ],
      globalPowersByGroup: new Map(),
    };
    const group = compileGroupSnapshot(data, ["1"]);

    expect(group.bits.get("1")).toBe(0);
  });

  test("a hidden ancestor hides every descendant", () => {
    const tree = createForumTree([
      { id: "1", parentId: null, passwordProtected: false },
      { id: "2", parentId: "1", passwordProtected: false },
      { id: "3", parentId: "2", passwordProtected: false },
    ]);
    const data: PermissionData = {
      tree,
      masksByGroup: new Map([["1", ["10"]]]),
      matrix: [
        { forumId: "1", maskId: "10", actions: forumActionMask(["show", "read"]), inherits: false },
        { forumId: "2", maskId: "10", actions: 0, inherits: false },
        {
          forumId: "3",
          maskId: "10",
          actions: forumActionMask(["show", "read", "reply"]),
          inherits: false,
        },
      ],
      globalPowersByGroup: new Map(),
    };
    const group = compileGroupSnapshot(data, ["1"]);

    expect(group.bits.get("1")).toBe(forumActionMask(["show", "read"]));
    expect(group.bits.get("2")).toBe(0);
    expect(group.bits.get("3")).toBe(0);
  });
});
