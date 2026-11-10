import { forumAnnouncementsTag, forumTag, GLOBAL_CACHE_TAGS } from "@bulletin/cache";
import type { Mutation } from "./index.ts";

export interface ForumTreeChange {
  /** The moved forum, its old and new ancestors and its whole subtree. */
  readonly affectedForumIds: readonly string[];
}

export interface ForumSettingsChange {
  /** The edited forum, its ancestors (breadcrumbs elsewhere) and its subtree. */
  readonly affectedForumIds: readonly string[];
}

export interface PrefixChange {
  /** Forums whose prefix set uses this prefix; only their pages render the labels. */
  readonly affectedForumIds: readonly string[];
}

/** Prefix labels, colours and group restrictions live only on forum pages. */
export const prefixMutation: Mutation<PrefixChange, { readonly ok: boolean }> = {
  name: "prefix.update",
  tags: (input, result) => (result.ok ? uniqueTags(input.affectedForumIds.map(forumTag)) : []),
};

export interface AnnouncementChange {
  readonly announcementId: string;
  readonly scope: "global" | "forums";
  /** Every forum whose announcement block can show this announcement. */
  readonly forumIds: readonly string[];
  /** True when a scope change removes the announcement from the global block too. */
  readonly bumpGlobal?: boolean;
}

function uniqueTags(tags: readonly string[]): readonly string[] {
  return [...new Set(tags)];
}

/**
 * A tree move changes the index, the moved forum and every page whose breadcrumbs or
 * sub-forum links point at it (ADR 0006). The caller passes the whole affected set because
 * only it knows the old and new parent chains.
 */
export const forumTreeMutation: Mutation<ForumTreeChange, void> = {
  name: "forum.tree.move",
  tags: (input) => uniqueTags([GLOBAL_CACHE_TAGS.board, ...input.affectedForumIds.map(forumTag)]),
};

/** A settings/name/rules save changes the index, the forum and ancestor/descendant breadcrumbs. */
export const forumSettingsMutation: Mutation<ForumSettingsChange, void> = {
  name: "forum.settings.update",
  tags: (input) => uniqueTags([GLOBAL_CACHE_TAGS.board, ...input.affectedForumIds.map(forumTag)]),
};

/**
 * Announcement edits invalidate the global notice block or the affected forum blocks. They
 * never touch forum content fragments, which stay cached (ADR 0006).
 */
export const announcementMutation: Mutation<AnnouncementChange, void> = {
  name: "announcement.update",
  tags: (input) =>
    uniqueTags([
      ...(input.scope === "global" || input.bumpGlobal === true
        ? [GLOBAL_CACHE_TAGS.announcements]
        : []),
      ...input.forumIds.map(forumAnnouncementsTag),
    ]),
};
