import type { CapabilityDep, ForumTree } from "@bulletin/domain/permissions";

/**
 * The capability bits the board index and forum pages may read. A forum page depends on its
 * ancestors for breadcrumbs and its own read/mod bits; declaring every forum keeps the
 * visibility key complete when a parent or child visibility changes (ADR 0005).
 */
export function forumCapabilityDeps(tree: ForumTree): readonly CapabilityDep[] {
  return tree.ids.flatMap((forumId) => [
    { forumId, bit: "show" as const },
    { forumId, bit: "read" as const },
    { forumId, bit: "see_unapproved" as const },
    { forumId, bit: "see_deleted" as const },
  ]);
}
