import { createForumTree, type ForumNode, type ForumTree } from "./tree.ts";

/**
 * The fixture tree used by permission tests and by the dev-only demo route from spike S1.
 * It has two categories, three levels of nesting and one password-protected forum.
 */
export const FIXTURE_FORUM_NODES: readonly ForumNode[] = [
  { id: "1", parentId: null, passwordProtected: false },
  { id: "2", parentId: "1", passwordProtected: false },
  { id: "3", parentId: "1", passwordProtected: true },
  { id: "4", parentId: "3", passwordProtected: false },
  { id: "5", parentId: "3", passwordProtected: false },
  { id: "6", parentId: null, passwordProtected: false },
  { id: "7", parentId: "6", passwordProtected: false },
  { id: "8", parentId: "7", passwordProtected: false },
  { id: "9", parentId: null, passwordProtected: false },
  { id: "10", parentId: null, passwordProtected: false },
];

export const FIXTURE_FORUM_TREE: ForumTree = createForumTree(FIXTURE_FORUM_NODES);

export const FIXTURE_PASSWORD_FORUM_ID = "3";
