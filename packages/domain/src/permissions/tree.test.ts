import { describe, expect, test } from "bun:test";
import { FIXTURE_FORUM_TREE } from "./fixtures.ts";
import { createForumTree, ForumTreeError } from "./tree.ts";

const NODES = [
  { id: "1", parentId: null, passwordProtected: false },
  { id: "2", parentId: "1", passwordProtected: false },
  { id: "3", parentId: "2", passwordProtected: false },
  { id: "4", parentId: "2", passwordProtected: true },
  { id: "5", parentId: null, passwordProtected: false },
];

describe("forum tree", () => {
  test("returns the lineage root first and the ancestors without the node", () => {
    const tree = createForumTree(NODES);

    expect(tree.lineage("4").map((node) => node.id)).toEqual(["1", "2", "4"]);
    expect(tree.ancestors("4").map((node) => node.id)).toEqual(["1", "2"]);
    expect(tree.ancestors("1")).toEqual([]);
    expect(tree.lineage("99")).toEqual([]);
    expect(tree.get("4")?.passwordProtected).toBe(true);
  });

  test("returns descendants breadth first, excluding the node", () => {
    const tree = createForumTree(NODES);

    expect(tree.descendants("1").map((node) => node.id)).toEqual(["2", "3", "4"]);
    expect(tree.descendants("3")).toEqual([]);
    expect(tree.descendants("99")).toEqual([]);
    expect(tree.roots.map((node) => node.id)).toEqual(["1", "5"]);
  });

  test("rejects duplicate ids, missing parents, self-parents and cycles", () => {
    expect(() =>
      createForumTree([
        { id: "1", parentId: null, passwordProtected: false },
        { id: "1", parentId: null, passwordProtected: false },
      ]),
    ).toThrow(ForumTreeError);

    expect(() => createForumTree([{ id: "1", parentId: "2", passwordProtected: false }])).toThrow(
      "missing parent",
    );

    expect(() => createForumTree([{ id: "1", parentId: "1", passwordProtected: false }])).toThrow(
      "own parent",
    );

    expect(() =>
      createForumTree([
        { id: "1", parentId: "2", passwordProtected: false },
        { id: "2", parentId: "1", passwordProtected: false },
      ]),
    ).toThrow("cycle");
  });

  test("the fixture tree has three levels and a password forum", () => {
    const forum = FIXTURE_FORUM_TREE.get("8");
    expect(forum).toBeDefined();
    expect(FIXTURE_FORUM_TREE.ancestors("8").map((node) => node.id)).toEqual(["6", "7"]);
    expect(FIXTURE_FORUM_TREE.get("3")?.passwordProtected).toBe(true);
    expect(FIXTURE_FORUM_TREE.get("4")?.passwordProtected).toBe(false);
    expect(FIXTURE_FORUM_TREE.lineage("4").map((node) => node.id)).toEqual(["1", "3", "4"]);
  });
});
