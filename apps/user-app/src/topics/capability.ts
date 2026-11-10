import { type CapabilityDep, type ForumTree, MODERATOR_POWERS } from "@bulletin/domain/permissions";

/** Bits the topic route reads on the topic forum itself (ADR 0005). */
const OWN_BITS = ["reply", "upload", "vote", ...MODERATOR_POWERS] as const;

/**
 * The topic page declares the visibility bits of every forum (breadcrumbs and linked forums),
 * the action and moderator bits of its own forum chain, and the read bit of every forum quoted
 * on the page. Quoted forums are known from `posts.quoted_forum_ids` before the cache lookup.
 */
export function topicCapabilityDeps(
  tree: ForumTree,
  forumId: string,
  quotedForumIds: readonly string[],
): readonly CapabilityDep[] {
  const own = new Set([...tree.ancestors(forumId).map((node) => node.id), forumId]);
  const deps: CapabilityDep[] = [];

  for (const id of tree.ids) {
    deps.push({ forumId: id, bit: "show" });
    deps.push({ forumId: id, bit: "read" });
    deps.push({ forumId: id, bit: "see_unapproved" });
    deps.push({ forumId: id, bit: "see_deleted" });
  }

  for (const id of own) {
    for (const bit of OWN_BITS) {
      deps.push({ forumId: id, bit });
    }
  }

  for (const quoted of quotedForumIds) {
    deps.push({ forumId: quoted, bit: "read" });
  }

  return deps;
}
