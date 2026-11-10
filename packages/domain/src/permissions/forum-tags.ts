import { forumTag } from "@bulletin/cache";
import type { SQL } from "bun";
import { loadForumTree } from "./tree-store.ts";

/**
 * Every CDN surrogate key a forum page may carry: the forum and its subtree. A permission
 * change at a forum must purge the whole subtree, since descendants inherit the visibility
 * (ADR 0006 guest revocation).
 */
export async function forumSubtreeTags(sql: SQL, forumId: string): Promise<readonly string[]> {
  const tree = await loadForumTree(sql);

  if (tree.get(forumId) === undefined) {
    return [];
  }

  return [forumId, ...tree.descendants(forumId).map((node) => node.id)].map(forumTag);
}
