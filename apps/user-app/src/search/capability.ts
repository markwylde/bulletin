import type { CapabilityDep, ForumTree } from "@bulletin/domain/permissions";

/**
 * Search results depend on every forum's read state, the moderator visibility powers and the
 * forum names in the filter. Declaring all of them keeps the variant complete (ADR 0005).
 */
export function searchCapabilityDeps(tree: ForumTree): readonly CapabilityDep[] {
  return tree.ids.flatMap((forumId) => [
    { forumId, bit: "show" as const },
    { forumId, bit: "read" as const },
    { forumId, bit: "see_unapproved" as const },
    { forumId, bit: "see_deleted" as const },
  ]);
}
