import {
  type ForumPrefix,
  type ForumRecord,
  listForumModerators,
  listForumPrefixes,
  listVisibleForums,
} from "@bulletin/domain/forums";
import {
  announcementAudienceClass,
  announcementsForForum,
  CapabilityView,
  can,
  filterVisibleAnnouncements,
  loadAnnouncements,
  nextAnnouncementTransitionMs,
  type PermissionSnapshot,
  type ViewerPrincipal,
} from "@bulletin/domain/permissions";
import { canonicalUrl } from "@bulletin/domain/urls";
import type { Locale, Translator } from "@bulletin/i18n";
import type { SQL } from "bun";
import { forumCapabilityDeps } from "./capability.ts";

export interface ForumPageAnnouncement {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly dismissible: boolean;
  readonly version: number;
}

export interface ForumPagePrefix {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly colour: string;
}

export interface ForumPageChild {
  readonly id: string;
  readonly title: string;
  readonly href: string;
}

export interface ForumPageView {
  readonly forumId: string;
  readonly title: string;
  readonly href: string;
  readonly description: string;
  readonly topicCount: string;
  readonly postCount: string;
  readonly rules: string | null;
  readonly prefixes: readonly ForumPagePrefix[];
  readonly activePrefix: string | null;
  readonly announcements: readonly ForumPageAnnouncement[];
  readonly moderators: readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
  }[];
  readonly showModerators: boolean;
  readonly isModerator: boolean;
  readonly isCategory: boolean;
  readonly locked: boolean;
  readonly children: readonly ForumPageChild[];
  readonly flags: Readonly<Record<string, boolean>>;
}

export interface ForumPageInput {
  readonly sql: SQL;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly principal: ViewerPrincipal;
  readonly sessionId: string | null;
  readonly snapshot: PermissionSnapshot;
  readonly forum: ForumRecord;
  readonly prefix: string | null;
  readonly now: Date;
  readonly announcementsEnabled?: boolean;
}

export interface ForumPageBreadcrumb {
  readonly label: string;
  readonly href: string | null;
}

export interface ForumPageData {
  readonly viewModel: ForumPageView;
  readonly breadcrumbs: readonly ForumPageBreadcrumb[];
  readonly visibilityKey: string;
  readonly hasUnlockGrant: boolean;
  readonly ttlMs: number | null;
}

/**
 * Builds a forum page view model. The route has already established `show`, `read` and any
 * password unlock; this function only reads what that viewer may see and hashes exactly the
 * declared capability answers plus the announcement audience class (ADR 0005, 0006).
 */
export async function buildForumPage(input: ForumPageInput): Promise<ForumPageData> {
  const tree = input.snapshot.tree;
  const groupIds = input.snapshot.groupIds;
  const view = new CapabilityView({
    ...input.snapshot,
    deps: forumCapabilityDeps(tree),
    view: "forum-page",
  });
  const ancestorIds = tree.ancestors(input.forum.id).map((node) => node.id);
  const visibleRows = await listVisibleForums(input.sql, view);
  const visibleById = new Map(visibleRows.map((row) => [row.id, row]));
  const breadcrumbs = [...ancestorIds, input.forum.id].map((forumId) => {
    const forum = forumId === input.forum.id ? input.forum : visibleById.get(forumId);

    return {
      label: forum?.title ?? "",
      href:
        forumId === input.forum.id || forum === undefined
          ? null
          : canonicalUrl("forum", forum.id, forum.slug),
    };
  });
  const readable = await can(input.sql, input.principal, "read", {
    forumId: input.forum.id,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.forum.id, "read", readable);
  const locked = input.forum.passwordProtected && !readable;

  const announcementsEnabled = input.announcementsEnabled !== false;
  const allAnnouncements = announcementsEnabled
    ? await loadAnnouncements(input.sql, input.now)
    : [];
  const announcements = await filterVisibleAnnouncements(
    input.sql,
    input.principal,
    allAnnouncements,
    { tree, snapshot: input.snapshot, forumId: input.forum.id },
  );
  const pageAnnouncements = announcementsEnabled
    ? announcementsForForum(
        announcements,
        { id: input.forum.id, path: input.forum.path },
        input.now,
      )
    : [];
  const audience = announcementAudienceClass(announcements, groupIds, input.now);
  const allPrefixes =
    locked || input.forum.type === "category" || input.forum.prefixMode === "none"
      ? []
      : await listForumPrefixes(input.sql, input.forum.id, input.locale);
  const prefixes: ForumPrefix[] = [];

  for (const prefix of allPrefixes) {
    if (await can(input.sql, input.principal, "view_prefix", { prefixId: prefix.id })) {
      prefixes.push(prefix);
    }
  }

  const prefixKey = Bun.hash
    .xxHash64(
      prefixes
        .map((prefix) => prefix.id)
        .sort()
        .join("\u0000"),
    )
    .toString(16);
  const visibilityKey = `${view.visibilityKey()}|audience:${audience}|prefixes:${prefixKey}`;
  const ttlMs = announcementsEnabled
    ? nextAnnouncementTransitionMs(announcements, input.now)
    : null;

  if (locked) {
    return {
      breadcrumbs,
      viewModel: {
        forumId: input.forum.id,
        title: input.forum.title,
        href: canonicalUrl("forum", input.forum.id, input.forum.slug),
        description: input.forum.description,
        topicCount: input.translate("index.topicCount", { count: input.forum.topicCount }),
        postCount: input.translate("index.postCount", { count: input.forum.postCount }),
        rules: null,
        prefixes: [],
        activePrefix: null,
        announcements: [],
        moderators: [],
        showModerators: false,
        isModerator: false,
        isCategory: false,
        locked: true,
        children: [],
        flags: { announcements: announcementsEnabled },
      },
      visibilityKey,
      hasUnlockGrant: view.hasUnlockGrant,
      ttlMs,
    };
  }

  const moderators = input.forum.showModerators
    ? await listForumModerators(input.sql, input.forum.id, ancestorIds)
    : [];
  const activePrefix =
    input.prefix !== null && prefixes.some((prefix) => prefix.key === input.prefix)
      ? input.prefix
      : null;
  const isModerator = await can(input.sql, input.principal, "see_unapproved", {
    forumId: input.forum.id,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.forum.id, "see_unapproved", isModerator);

  const blocks = input.forum.type === "category" ? [] : pageAnnouncements;

  return {
    breadcrumbs,
    viewModel: {
      forumId: input.forum.id,
      title: input.forum.title,
      href: canonicalUrl("forum", input.forum.id, input.forum.slug),
      description: input.forum.description,
      topicCount: input.translate("index.topicCount", { count: input.forum.topicCount }),
      postCount: input.translate("index.postCount", { count: input.forum.postCount }),
      rules: input.forum.rules.trim() === "" ? null : input.forum.rules,
      prefixes,
      activePrefix,
      announcements: blocks.map((announcement) => ({
        id: announcement.id,
        title: announcement.title,
        body: announcement.body,
        dismissible: announcement.dismissible,
        version: announcement.version,
      })),
      moderators: moderators.map((moderator) => ({
        id: moderator.id,
        name: moderator.name,
        kind: moderator.kind,
      })),
      showModerators: input.forum.showModerators,
      isModerator,
      isCategory: input.forum.type === "category",
      locked: false,
      children: visibleRows
        .filter((child) => child.parentId === input.forum.id && child.type !== "category")
        .map((child) => ({
          id: child.id,
          title: child.title,
          href: canonicalUrl("forum", child.id, child.slug),
        })),
      flags: { announcements: announcementsEnabled },
    },
    visibilityKey,
    hasUnlockGrant: view.hasUnlockGrant,
    ttlMs,
  };
}
