import { ensureCurrentRendering, type ReplaceWords, replaceWordsInText } from "@bulletin/content";
import { listEmbedProviders } from "@bulletin/domain/content";
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
import { readTopicList } from "@bulletin/domain/topics";
import { canonicalUrl } from "@bulletin/domain/urls";
import type { Locale, Translator } from "@bulletin/i18n";
import { escapeHtml, type SafeHtml, safeHtml } from "@bulletin/templates";
import type { SQL } from "bun";
import { buildEditorView, type EditorView } from "../editor.ts";
import { forumCapabilityDeps } from "./capability.ts";

export interface ForumPageAnnouncement {
  readonly id: string;
  readonly title: string;
  readonly body: SafeHtml;
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

export interface ForumPageTopic {
  readonly id: string;
  readonly title: string;
  readonly href: string;
  readonly pinned: boolean;
  readonly locked: boolean;
  readonly moved: boolean;
  readonly prefix: ForumPagePrefix | null;
  readonly replies: string;
  readonly views: string;
  readonly bulk: boolean;
  readonly lastPost: { readonly date: string; readonly memberName: string | null } | null;
}

export interface ForumPagePagination {
  readonly page: number;
  readonly pageCount: number;
  readonly previousHref: string | null;
  readonly nextHref: string | null;
}

export interface ForumPageView {
  readonly forumId: string;
  readonly title: string;
  readonly href: string;
  readonly description: string;
  readonly topicCount: string;
  readonly postCount: string;
  readonly rules: SafeHtml | null;
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
  readonly topics: readonly ForumPageTopic[];
  readonly pagination: ForumPagePagination;
  readonly canStart: boolean;
  readonly bulkTopics: {
    readonly pin: boolean;
    readonly unpin: boolean;
    readonly lock: boolean;
    readonly unlock: boolean;
    readonly move: boolean;
    readonly softDelete: boolean;
    readonly restore: boolean;
    readonly approve: boolean;
  };
  readonly moveTargets: readonly { readonly id: string; readonly title: string }[];
  readonly prefixRequired: boolean;
  readonly editor: EditorView | null;
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
  /** The requested topic-list page (1-based). */
  readonly page?: number;
  readonly topicsPerPage?: number;
  readonly now: Date;
  readonly announcementsEnabled?: boolean;
  /** The viewer's evaluated `mentions` flag; off unwraps stored mention links (ADR 0010). */
  readonly mentionsEnabled?: boolean;
  /** The viewer's evaluated `polls` flag; off hides the poll builder (ADR 0010). */
  readonly pollsEnabled?: boolean;
  /** The viewer's evaluated `attachments` flag; off hides uploads and attachment UI. */
  readonly attachmentsEnabled?: boolean;
  /** The viewer's evaluated `pwa` flag; off disables local draft storage in the editor. */
  readonly pwaEnabled?: boolean;
  readonly replaceWords?: ReplaceWords;
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
  const attachmentsEnabled = input.attachmentsEnabled !== false;
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
  const mentionsEnabled = input.mentionsEnabled !== false;
  const pollsEnabled = input.pollsEnabled !== false;
  const pwaEnabled = input.pwaEnabled === true;
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
        topics: [],
        pagination: { page: 1, pageCount: 1, previousHref: null, nextHref: null },
        canStart: false,
        bulkTopics: {
          pin: false,
          unpin: false,
          lock: false,
          unlock: false,
          move: false,
          softDelete: false,
          restore: false,
          approve: false,
        },
        moveTargets: [],
        prefixRequired: false,
        editor: null,
        flags: {
          announcements: announcementsEnabled,
          polls: pollsEnabled,
          attachments: attachmentsEnabled,
          pwa: pwaEnabled,
        },
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
  const seeDeleted = await can(input.sql, input.principal, "see_deleted", {
    forumId: input.forum.id,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.forum.id, "see_deleted", seeDeleted);
  const canStart = await can(input.sql, input.principal, "start", {
    forumId: input.forum.id,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.forum.id, "start", canStart);
  const canUpload = await can(input.sql, input.principal, "upload", {
    forumId: input.forum.id,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.forum.id, "upload", canUpload);
  const [canPin, canLockTopic, canMove, canSoftDeleteTopic, canRestoreTopic, canApproveTopic] =
    await Promise.all([
      can(input.sql, input.principal, "pin", {
        forumId: input.forum.id,
        tree,
        sessionId: input.sessionId,
        snapshot: input.snapshot,
      }),
      can(input.sql, input.principal, "lock", {
        forumId: input.forum.id,
        tree,
        sessionId: input.sessionId,
        snapshot: input.snapshot,
      }),
      can(input.sql, input.principal, "move", {
        forumId: input.forum.id,
        tree,
        sessionId: input.sessionId,
        snapshot: input.snapshot,
      }),
      can(input.sql, input.principal, "soft_delete", {
        forumId: input.forum.id,
        tree,
        sessionId: input.sessionId,
        snapshot: input.snapshot,
      }),
      can(input.sql, input.principal, "restore", {
        forumId: input.forum.id,
        tree,
        sessionId: input.sessionId,
        snapshot: input.snapshot,
      }),
      can(input.sql, input.principal, "approve", {
        forumId: input.forum.id,
        tree,
        sessionId: input.sessionId,
        snapshot: input.snapshot,
      }),
    ]);
  for (const [bit, allowed] of [
    ["pin", canPin],
    ["lock", canLockTopic],
    ["move", canMove],
    ["soft_delete", canSoftDeleteTopic],
    ["restore", canRestoreTopic],
    ["approve", canApproveTopic],
  ] as const) {
    view.track(input.forum.id, bit, allowed);
  }
  const editor = canStart
    ? await buildEditorView(input.sql, input.translate, {
        contextKey: `topic:new:${input.forum.id}`,
        mentions: mentionsEnabled,
        attachments: attachmentsEnabled,
        pwa: pwaEnabled,
        name: "bodyMd",
        forumId: input.forum.id,
        canUpload,
      })
    : null;

  const prefixId =
    activePrefix === null
      ? null
      : (prefixes.find((prefix) => prefix.key === activePrefix)?.id ?? null);
  const perPage = input.topicsPerPage ?? 20;
  let topicPage = Math.max(1, Math.trunc(input.page ?? 1));
  let topicList =
    input.forum.type === "category"
      ? { rows: [], total: 0 }
      : await readTopicList(input.sql, {
          forumId: input.forum.id,
          locale: input.locale,
          sort: input.forum.defaultSort,
          prefixId,
          page: topicPage,
          perPage,
          seeUnapproved: isModerator,
          seeDeleted,
        });
  const pageCount = Math.max(1, Math.ceil(topicList.total / perPage));

  if (topicPage > pageCount) {
    topicPage = pageCount;
    topicList = await readTopicList(input.sql, {
      forumId: input.forum.id,
      locale: input.locale,
      sort: input.forum.defaultSort,
      prefixId,
      page: topicPage,
      perPage,
      seeUnapproved: isModerator,
      seeDeleted,
    });
  }

  const pageHref = (page: number): string => {
    const base = canonicalUrl("forum", input.forum.id, input.forum.slug);
    const params = new URLSearchParams();

    if (activePrefix !== null) {
      params.set("prefix", activePrefix);
    }

    if (page > 1) {
      params.set("page", String(page));
    }

    const query = params.toString();
    return query === "" ? base : `${base}?${query}`;
  };
  const formatDate = (value: Date): string =>
    new Intl.DateTimeFormat(input.locale, { dateStyle: "medium", timeStyle: "short" }).format(
      value,
    );
  const topics: ForumPageTopic[] = topicList.rows.map((topic) => ({
    id: topic.id,
    title: replaceWordsInText(topic.title, input.replaceWords),
    href:
      topic.movedTo === null
        ? canonicalUrl("topic", topic.id, topic.slug)
        : `/topic/${topic.movedTo}`,
    pinned: topic.pinned,
    locked: topic.locked,
    moved: topic.movedTo !== null,
    prefix:
      topic.prefixKey === null
        ? null
        : {
            id: topic.prefixId ?? topic.prefixKey,
            key: topic.prefixKey,
            label: topic.prefixLabel ?? topic.prefixKey,
            colour: topic.prefixColour ?? "#6b7280",
          },
    replies: input.translate("index.topicReplies", { count: topic.replyCount }),
    views: input.translate("index.topicViews", { count: Number(topic.viewCount) }),
    bulk:
      canPin || canLockTopic || canMove || canSoftDeleteTopic || canRestoreTopic || canApproveTopic,
    lastPost:
      topic.movedTo !== null || topic.lastPostAt === null
        ? null
        : {
            date: formatDate(topic.lastPostAt),
            memberName: topic.lastPostMemberName,
          },
  }));

  const blocks = input.forum.type === "category" ? [] : pageAnnouncements;
  const embedProviders = await listEmbedProviders(input.sql);
  const rules = await ensureCurrentRendering(
    {
      bodyHtml: input.forum.rulesHtml,
      bodyText: input.forum.rulesText,
      renderVersion: input.forum.rulesRenderVersion,
      sanitiserVersion: input.forum.rulesSanitiserVersion,
    },
    { profile: "rules", embedProviders, mentions: mentionsEnabled },
  );
  const announcementViews = await Promise.all(
    blocks.map(async (announcement) => ({
      announcement,
      rendered: await ensureCurrentRendering(
        {
          bodyHtml: announcement.bodyHtml,
          bodyText: announcement.bodyText,
          renderVersion: announcement.renderVersion,
          sanitiserVersion: announcement.sanitiserVersion,
        },
        { profile: "rules", embedProviders, mentions: mentionsEnabled },
      ),
    })),
  );

  return {
    breadcrumbs,
    viewModel: {
      forumId: input.forum.id,
      title: input.forum.title,
      href: canonicalUrl("forum", input.forum.id, input.forum.slug),
      description: input.forum.description,
      topicCount: input.translate("index.topicCount", { count: input.forum.topicCount }),
      postCount: input.translate("index.postCount", { count: input.forum.postCount }),
      rules:
        input.forum.rules.trim() === ""
          ? null
          : safeHtml(
              rules.bodyHtml.trim() === ""
                ? `<p>${escapeHtml(input.forum.rules)}</p>`
                : rules.bodyHtml,
            ),
      prefixes,
      activePrefix,
      announcements: announcementViews.map(({ announcement, rendered }) => ({
        id: announcement.id,
        title: announcement.title,
        body: safeHtml(
          rendered.bodyHtml.trim() === ""
            ? `<p>${escapeHtml(announcement.body)}</p>`
            : rendered.bodyHtml,
        ),
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
      topics,
      pagination: {
        page: topicPage,
        pageCount,
        previousHref: topicPage > 1 ? pageHref(topicPage - 1) : null,
        nextHref: topicPage < pageCount ? pageHref(topicPage + 1) : null,
      },
      canStart: canStart && !locked,
      bulkTopics: {
        pin: canPin,
        unpin: canPin,
        lock: canLockTopic,
        unlock: canLockTopic,
        move: canMove,
        softDelete: canSoftDeleteTopic,
        restore: canRestoreTopic,
        approve: canApproveTopic,
      },
      moveTargets: visibleRows
        .filter((forum) => forum.type === "forum" && forum.id !== input.forum.id)
        .map((forum) => ({ id: forum.id, title: forum.title })),
      prefixRequired: input.forum.prefixMode === "required",
      editor,
      flags: {
        announcements: announcementsEnabled,
        polls: pollsEnabled,
        attachments: attachmentsEnabled,
      },
    },
    visibilityKey,
    hasUnlockGrant: view.hasUnlockGrant,
    ttlMs,
  };
}
