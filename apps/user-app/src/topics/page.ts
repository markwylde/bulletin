import { forumTag, GLOBAL_CACHE_TAGS, postSnapshotsTag, postTag, topicTag } from "@bulletin/cache";
import {
  ensureCurrentRendering,
  type ReplaceWords,
  replaceWordsInText,
  resolveQuotePlaceholders,
} from "@bulletin/content";
import { type PostAttachmentRecord, readPostAttachments } from "@bulletin/domain/attachments";
import { listEmbedProviders, loadQuoteSnapshot } from "@bulletin/domain/content";
import { listVisibleForums } from "@bulletin/domain/forums";
import {
  CapabilityView,
  can,
  type PermissionSnapshot,
  principalMemberId,
  type ViewerPrincipal,
} from "@bulletin/domain/permissions";
import { readPollForTopic } from "@bulletin/domain/polls";
import {
  countTopicPosts,
  listMultimodForForum,
  loadQuoteSources,
  readTopicList,
  readTopicPostById,
  readTopicPostPage,
  readTopicPrefix,
  type TopicPostRow,
  type TopicRecord,
} from "@bulletin/domain/topics";
import { canonicalUrl } from "@bulletin/domain/urls";
import type { Locale, Translator } from "@bulletin/i18n";
import { escapeHtml, type SafeHtml, safeHtml } from "@bulletin/templates";
import type { SQL } from "bun";
import { buildEditorView, type EditorView } from "../editor.ts";
import { renderPostAttachments } from "./attachments.ts";
import { topicCapabilityDeps } from "./capability.ts";

export interface TopicPagePost {
  readonly id: string;
  readonly authorId: string | null;
  readonly position: number;
  readonly href: string;
  readonly authorCard: SafeHtml;
  readonly body: SafeHtml;
  readonly files: SafeHtml | null;
  readonly deleted: boolean;
  readonly unapproved: boolean;
  readonly createdAt: string;
  readonly editedMarker: string | null;
  readonly canEdit: boolean;
  readonly editBody: string | null;
  readonly canRedact: boolean;
  readonly canDelete: boolean;
  readonly canRestore: boolean;
  readonly canHardDelete: boolean;
  readonly canViewHistory: boolean;
  readonly canBulk: boolean;
  readonly canWarn: boolean;
}

export interface TopicPageView {
  readonly topicId: string;
  readonly forumId: string;
  readonly title: string;
  readonly href: string;
  readonly prefix: { readonly label: string; readonly colour: string } | null;
  readonly pinned: boolean;
  readonly locked: boolean;
  readonly isModerator: boolean;
  readonly replyCount: string;
  readonly posts: readonly TopicPagePost[];
  readonly pagination: {
    readonly page: number;
    readonly pageCount: number;
    readonly previousHref: string | null;
    readonly nextHref: string | null;
  };
  readonly viewsSlot: SafeHtml;
  readonly readMarkerAt: string | null;
  readonly readMarkerPostId: string | null;
  readonly canReply: boolean;
  readonly canHardDeleteTopic: boolean;
  readonly topicTools: {
    readonly pin: boolean;
    readonly unpin: boolean;
    readonly lock: boolean;
    readonly unlock: boolean;
    readonly move: boolean;
    readonly merge: boolean;
    readonly split: boolean;
    readonly multimod: boolean;
    readonly approvePosts: boolean;
    readonly deletePosts: boolean;
    readonly restorePosts: boolean;
  };
  readonly moveTargets: readonly { readonly id: string; readonly title: string }[];
  readonly mergeTargets: readonly { readonly id: string; readonly title: string }[];
  readonly multimodActions: readonly { readonly id: string; readonly name: string }[];
  readonly editor: EditorView | null;
  readonly pollId: string | null;
  readonly pollSlot: SafeHtml | null;
  readonly flags: Readonly<Record<string, boolean>>;
}

export interface TopicPageInput {
  readonly sql: SQL;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly principal: ViewerPrincipal;
  readonly sessionId: string | null;
  readonly snapshot: PermissionSnapshot;
  readonly topic: TopicRecord;
  readonly page: number;
  readonly perPage: number;
  readonly quotedForumIds: readonly string[];
  readonly mentionsEnabled?: boolean;
  readonly pollsEnabled?: boolean;
  readonly attachmentsEnabled?: boolean;
  readonly publicEditHistory?: boolean;
  readonly replaceWords?: ReplaceWords;
}

export interface TopicPageData {
  readonly viewModel: TopicPageView;
  readonly breadcrumbs: readonly { readonly label: string; readonly href: string | null }[];
  readonly visibilityKey: string;
  readonly hasUnlockGrant: boolean;
  readonly page: number;
  readonly pageCount: number;
  readonly memberIds: readonly string[];
  readonly pollId: string | null;
  readonly quoteTopicIds: readonly string[];
  readonly quotePostIds: readonly string[];
  readonly replaceWords?: ReplaceWords;
  readonly postTags: ReadonlyMap<string, readonly string[]>;
  readonly allPostTags: readonly string[];
  readonly loadPost: (postId: string) => Promise<TopicPagePost | null>;
  /** The viewer may react (a member whose groups allow it); own posts are excluded by overlay. */
  readonly canReact: boolean;
  readonly canGiveReputation: boolean;
  readonly canGiveNegativeReputation: boolean;
}

function formatDate(locale: Locale, value: Date): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(value);
}

function quoteSourceIds(html: string): readonly string[] {
  const ids: string[] = [];

  for (const match of html.matchAll(/<bl-quote\b[^>]*data-source="(\d+)"/g)) {
    if (match[1] !== undefined) {
      ids.push(match[1]);
    }
  }

  return ids;
}

export async function buildTopicPage(input: TopicPageInput): Promise<TopicPageData> {
  const attachmentsEnabled = input.attachmentsEnabled !== false;
  const tree = input.snapshot.tree;
  const view = new CapabilityView({
    ...input.snapshot,
    deps: topicCapabilityDeps(tree, input.topic.forumId, input.quotedForumIds),
    view: "topic-page",
  });
  const readable = await can(input.sql, input.principal, "read", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "read", readable);
  const seeUnapproved = await can(input.sql, input.principal, "see_unapproved", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "see_unapproved", seeUnapproved);
  const seeDeleted = await can(input.sql, input.principal, "see_deleted", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "see_deleted", seeDeleted);
  const reply = await can(input.sql, input.principal, "reply", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "reply", reply);
  const upload = await can(input.sql, input.principal, "upload", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "upload", upload);
  const vote = await can(input.sql, input.principal, "vote", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "vote", vote);
  const isModerator = seeUnapproved;
  const canEditMod = await can(input.sql, input.principal, "edit", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "edit", canEditMod);
  const canSoftDelete = await can(input.sql, input.principal, "soft_delete", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "soft_delete", canSoftDelete);
  const canRestore = await can(input.sql, input.principal, "restore", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "restore", canRestore);
  const canHardDelete = await can(input.sql, input.principal, "hard_delete", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "hard_delete", canHardDelete);
  const canViewHistory = await can(input.sql, input.principal, "view_edit_history", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "view_edit_history", canViewHistory);
  const canLock = await can(input.sql, input.principal, "lock", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "lock", canLock);
  const canPin = await can(input.sql, input.principal, "pin", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "pin", canPin);
  const canMove = await can(input.sql, input.principal, "move", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "move", canMove);
  const canMerge = await can(input.sql, input.principal, "merge", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "merge", canMerge);
  const canSplit = await can(input.sql, input.principal, "split", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "split", canSplit);
  const canUseMultimod = await can(input.sql, input.principal, "use_multimod", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "use_multimod", canUseMultimod);
  const canApprovePosts = await can(input.sql, input.principal, "approve", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "approve", canApprovePosts);
  const canWarn = await can(input.sql, input.principal, "warn", {
    forumId: input.topic.forumId,
    tree,
    sessionId: input.sessionId,
    snapshot: input.snapshot,
  });
  view.track(input.topic.forumId, "warn", canWarn);
  const editWindow = Number(input.snapshot.settings["posting.edit_window_minutes"] ?? 0);
  const canDeleteOwn = input.snapshot.settings["posting.can_delete_own"] === true;
  const viewerId = principalMemberId(input.principal);

  const total = await countTopicPosts(input.sql, {
    topicId: input.topic.id,
    seeUnapproved,
    seeDeleted,
  });
  const pageCount = Math.max(1, Math.ceil(total / input.perPage));
  const page = Math.max(1, Math.min(input.page, pageCount));
  const posts = await readTopicPostPage(input.sql, {
    topicId: input.topic.id,
    limit: input.perPage,
    offset: (page - 1) * input.perPage,
    seeUnapproved,
    seeDeleted,
  });
  const embedProviders = await listEmbedProviders(input.sql);
  const mentionsEnabled = input.mentionsEnabled !== false;
  const pollsEnabled = input.pollsEnabled !== false;
  const rendered = await Promise.all(
    posts.rows.map(async (post) => {
      const current = await ensureCurrentRendering(
        {
          bodyHtml: post.bodyHtml,
          bodyText: post.bodyText,
          renderVersion: post.renderVersion,
          sanitiserVersion: post.sanitiserVersion,
        },
        {
          profile: "post",
          embedProviders,
          mentions: mentionsEnabled,
          ...(input.replaceWords === undefined ? {} : { replaceWords: input.replaceWords }),
        },
      );

      return { post, html: current.bodyHtml };
    }),
  );
  const sourceIds = [...new Set(rendered.flatMap((entry) => quoteSourceIds(entry.html)))];
  const sources = new Map(await loadQuoteSources(input.sql, sourceIds));
  const resolver = {
    async loadSnapshot(snapshotId: string) {
      return loadQuoteSnapshot(input.sql, snapshotId);
    },
    async canRead(ref: { readonly kind: string; readonly id: string }): Promise<boolean> {
      if (ref.kind !== "post") {
        return false;
      }

      const source = sources.get(ref.id);

      if (source === undefined || source.visibility === "soft_deleted") {
        return false;
      }

      if (
        source.visibility === "unapproved" &&
        !(await can(input.sql, input.principal, "see_unapproved", {
          forumId: source.forumId,
          tree,
          sessionId: input.sessionId,
          snapshot: input.snapshot,
        }))
      ) {
        return false;
      }

      const allowed = await can(input.sql, input.principal, "read", {
        forumId: source.forumId,
        tree,
        sessionId: input.sessionId,
        snapshot: input.snapshot,
      });
      view.track(source.forumId, "read", allowed);
      view.track(
        source.forumId,
        "see_unapproved",
        await can(input.sql, input.principal, "see_unapproved", {
          forumId: source.forumId,
          tree,
          sessionId: input.sessionId,
          snapshot: input.snapshot,
        }),
      );
      return allowed;
    },
    sourceUrl(ref: { readonly kind: string; readonly id: string }): string | null {
      const source = sources.get(ref.id);

      return source === undefined
        ? null
        : canonicalUrl("topic", source.topicId, source.topicSlug, { postId: source.postId });
    },
  };
  const bodies = await Promise.all(
    rendered.map((entry) =>
      resolveQuotePlaceholders(entry.html, {
        resolver,
        viewerId: principalMemberId(input.principal),
        translate: input.translate,
      }),
    ),
  );
  const attachmentsByPost = await readPostAttachments(
    input.sql,
    posts.rows.map((post) => post.id),
  );
  const buildPostView = (
    post: TopicPostRow,
    bodyHtml: string,
    attachments: readonly PostAttachmentRecord[],
  ): TopicPagePost => {
    const renderedAttachments = renderPostAttachments({
      postId: post.id,
      html: bodyHtml,
      attachments,
      locale: input.locale,
      translate: input.translate,
      canRemove: canEditMod,
      enabled: attachmentsEnabled,
    });

    return {
      id: post.id,
      authorId: post.authorId,
      position: post.position,
      href: canonicalUrl("topic", input.topic.id, input.topic.slug, { postId: post.id }),
      authorCard:
        post.authorId === null
          ? safeHtml(
              `<span class="bl-author-card bl-author-card--deleted">${escapeHtml(
                input.translate("member.deletedName"),
              )}</span>`,
            )
          : safeHtml(`<bl-member-card data-member="${post.authorId}"></bl-member-card>`),
      body: safeHtml(renderedAttachments.bodyHtml),
      files: renderedAttachments.files,
      deleted: post.visibility === "soft_deleted",
      unapproved: post.visibility === "unapproved",
      createdAt: formatDate(input.locale, post.createdAt),
      editedMarker: editedMarker(input, post),
      ...postActions({
        post,
        viewerId,
        canEditMod,
        canSoftDelete,
        canRestore,
        canHardDelete,
        canViewHistory,
        publicEditHistory: input.publicEditHistory === true,
        editWindow,
        canDeleteOwn,
        canBulk: canSoftDelete || canRestore || canApprovePosts,
        canWarn,
      }),
    };
  };
  const postViews = posts.rows.map((post, index) =>
    buildPostView(post, bodies[index] ?? post.bodyHtml, attachmentsByPost.get(post.id) ?? []),
  );
  const loadPost = async (postId: string): Promise<TopicPagePost | null> => {
    const fresh = await readTopicPostById(input.sql, {
      topicId: input.topic.id,
      postId,
      seeUnapproved,
      seeDeleted,
    });

    if (fresh === null) {
      return null;
    }

    const current = await ensureCurrentRendering(
      {
        bodyHtml: fresh.bodyHtml,
        bodyText: fresh.bodyText,
        renderVersion: fresh.renderVersion,
        sanitiserVersion: fresh.sanitiserVersion,
      },
      {
        profile: "post",
        embedProviders,
        mentions: mentionsEnabled,
        ...(input.replaceWords === undefined ? {} : { replaceWords: input.replaceWords }),
      },
    );
    const missing = quoteSourceIds(current.bodyHtml).filter((id) => !sources.has(id));

    if (missing.length > 0) {
      const extra = await loadQuoteSources(input.sql, missing);

      for (const [id, source] of extra) {
        sources.set(id, source);
      }
    }

    const bodyHtml = await resolveQuotePlaceholders(current.bodyHtml, {
      resolver,
      viewerId: principalMemberId(input.principal),
      translate: input.translate,
    });
    const attachments = await readPostAttachments(input.sql, [fresh.id]);

    return buildPostView(fresh, bodyHtml, attachments.get(fresh.id) ?? []);
  };

  const visibleForums = await listVisibleForums(input.sql, view);
  const visibleById = new Map(visibleForums.map((forum) => [forum.id, forum]));
  const moveTargets = visibleForums
    .filter((forum) => forum.type === "forum")
    .map((forum) => ({ id: forum.id, title: forum.title }));
  const mergeList = canMerge
    ? await readTopicList(input.sql, {
        forumId: input.topic.forumId,
        locale: input.locale,
        sort: "last_post",
        prefixId: null,
        page: 1,
        perPage: 100,
        seeUnapproved,
        seeDeleted,
      })
    : { rows: [], total: 0 };
  const mergeTargets = mergeList.rows
    .filter((row) => row.id !== input.topic.id && row.movedTo === null)
    .map((row) => ({ id: row.id, title: row.title }));
  const multimodActions = canUseMultimod
    ? (await listMultimodForForum(input.sql, input.topic.forumId)).map((action) => ({
        id: action.id,
        name: action.name,
      }))
    : [];
  const ancestorIds = tree.ancestors(input.topic.forumId).map((node) => node.id);
  const breadcrumbs = [...ancestorIds, input.topic.forumId].map((forumId) => {
    const forum = visibleById.get(forumId);

    return {
      label: forum?.title ?? "",
      href:
        forumId === input.topic.forumId || forum === undefined
          ? null
          : canonicalUrl("forum", forum.id, forum.slug),
    };
  });
  const pageHref = (target: number): string =>
    canonicalUrl("topic", input.topic.id, input.topic.slug, { page: target });
  const quoteTopicIds = [...new Set([...sources.values()].map((source) => source.topicId))];
  const quotePostIds = [...new Set(sourceIds)];
  const postTags = new Map<string, readonly string[]>();

  for (const { post, html: body } of rendered) {
    const tags = new Set<string>([postTag(post.id)]);

    for (const sourceId of quoteSourceIds(body)) {
      const source = sources.get(sourceId);

      if (source !== undefined) {
        tags.add(topicTag(source.topicId));
        tags.add(forumTag(source.forumId));
        tags.add(postSnapshotsTag(sourceId));
      }
    }

    postTags.set(post.id, [...tags]);
  }
  const memberIds = posts.rows.flatMap((post) => (post.authorId === null ? [] : [post.authorId]));
  const poll = pollsEnabled ? await readPollForTopic(input.sql, input.topic.id) : null;
  const allPostTags = [
    GLOBAL_CACHE_TAGS.board,
    GLOBAL_CACHE_TAGS.filters,
    ...quoteTopicIds.map(topicTag),
    ...quotePostIds.map(postSnapshotsTag),
    ...[...sources.values()].map((source) => forumTag(source.forumId)),
  ];

  return {
    breadcrumbs,
    visibilityKey: view.visibilityKey(),
    hasUnlockGrant: view.hasUnlockGrant,
    page,
    pageCount,
    memberIds,
    canReact:
      principalMemberId(input.principal) !== null &&
      (await can(input.sql, input.principal, "react")),
    canGiveReputation:
      principalMemberId(input.principal) !== null &&
      (await can(input.sql, input.principal, "give_reputation")),
    canGiveNegativeReputation:
      principalMemberId(input.principal) !== null &&
      (await can(input.sql, input.principal, "give_negative_reputation")),
    pollId: poll?.id ?? null,
    postTags,
    allPostTags: [...new Set(allPostTags)],
    loadPost,
    quoteTopicIds: quoteTopicIds,
    quotePostIds,
    viewModel: {
      topicId: input.topic.id,
      forumId: input.topic.forumId,
      title: replaceWordsInText(input.topic.title, input.replaceWords),
      href: canonicalUrl("topic", input.topic.id, input.topic.slug),
      prefix:
        input.topic.prefixId === null
          ? null
          : await readTopicPrefix(input.sql, input.topic.prefixId, input.locale),
      pinned: input.topic.pinned,
      locked: input.topic.locked,
      isModerator,
      replyCount: input.translate("index.topicReplies", { count: input.topic.replyCount }),
      posts: postViews,
      pagination: {
        page,
        pageCount,
        previousHref: page > 1 ? pageHref(page - 1) : null,
        nextHref: page < pageCount ? pageHref(page + 1) : null,
      },
      viewsSlot: safeHtml("<bl-topic-views></bl-topic-views>"),
      readMarkerAt:
        posts.rows.length === 0
          ? null
          : (posts.rows[posts.rows.length - 1]?.createdAt.toISOString() ?? null),
      readMarkerPostId: posts.rows[posts.rows.length - 1]?.id ?? null,
      canReply: reply && (!input.topic.locked || canLock),
      canHardDeleteTopic: canHardDelete,
      topicTools: {
        pin: canPin && !input.topic.pinned,
        unpin: canPin && input.topic.pinned,
        lock: canLock && !input.topic.locked,
        unlock: canLock && input.topic.locked,
        move: canMove,
        merge: canMerge,
        split: canSplit,
        multimod: canUseMultimod,
        approvePosts: canApprovePosts,
        deletePosts: canSoftDelete,
        restorePosts: canRestore,
      },
      moveTargets,
      mergeTargets,
      multimodActions,
      pollId: poll?.id ?? null,
      pollSlot: poll === null ? null : safeHtml("<bl-poll></bl-poll>"),
      editor:
        reply && (!input.topic.locked || canLock)
          ? await buildEditorView(input.sql, input.translate, {
              contextKey: `reply:topic:${input.topic.id}`,
              mentions: mentionsEnabled,
              attachments: attachmentsEnabled,
              name: "bodyMd",
              forumId: input.topic.forumId,
              canUpload: upload,
            })
          : null,
      flags: {
        mentions: mentionsEnabled,
        polls: pollsEnabled,
        attachments: attachmentsEnabled,
      },
    },
  };
}

function postActions(input: {
  readonly post: TopicPostRow;
  readonly viewerId: string | null;
  readonly canEditMod: boolean;
  readonly canSoftDelete: boolean;
  readonly canRestore: boolean;
  readonly canHardDelete: boolean;
  readonly canViewHistory: boolean;
  readonly publicEditHistory: boolean;
  readonly editWindow: number;
  readonly canDeleteOwn: boolean;
  readonly canBulk: boolean;
  readonly canWarn: boolean;
}): Pick<
  TopicPagePost,
  | "canEdit"
  | "editBody"
  | "canRedact"
  | "canDelete"
  | "canRestore"
  | "canHardDelete"
  | "canViewHistory"
  | "canBulk"
  | "canWarn"
> {
  const visible = input.post.visibility === "visible";
  void input.editWindow;
  void input.canDeleteOwn;

  // Ownership-dependent controls and raw Markdown are delivered through the private overlay,
  // never in the shared page fragment (task 5.1 reviewer finding).
  return {
    canEdit: input.canEditMod,
    editBody: input.canEditMod ? input.post.bodyMd : null,
    // Redaction is ownership-dependent; the private overlay supplies it per viewer.
    canRedact: false,
    canDelete: visible && input.canSoftDelete,
    canRestore: !visible && input.canRestore,
    canHardDelete: input.canHardDelete && input.post.position !== 1,
    canViewHistory: input.canViewHistory || input.publicEditHistory,
    canBulk: input.canBulk,
    canWarn: input.canWarn && input.post.authorId !== null,
  };
}

function editedMarker(input: TopicPageInput, post: TopicPostRow): string | null {
  if (post.editedAt === null) {
    return null;
  }

  if (post.editedAt.getTime() - post.createdAt.getTime() <= 5 * 60 * 1_000) {
    return null;
  }

  return input.translate("post.editedByAt", {
    member: post.editedByName ?? input.translate("member.deletedName"),
    date: formatDate(input.locale, post.editedAt),
  });
}
