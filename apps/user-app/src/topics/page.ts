import { ensureCurrentRendering, resolveQuotePlaceholders } from "@bulletin/content";
import { listEmbedProviders, loadQuoteSnapshot } from "@bulletin/domain/content";
import { listVisibleForums } from "@bulletin/domain/forums";
import {
  CapabilityView,
  can,
  type PermissionSnapshot,
  principalMemberId,
  type ViewerPrincipal,
} from "@bulletin/domain/permissions";
import {
  countTopicPosts,
  loadQuoteSources,
  readTopicPostPage,
  readTopicPrefix,
  type TopicPostRow,
  type TopicRecord,
} from "@bulletin/domain/topics";
import { canonicalUrl } from "@bulletin/domain/urls";
import type { Locale, Translator } from "@bulletin/i18n";
import { escapeHtml, type SafeHtml, safeHtml } from "@bulletin/templates";
import type { SQL } from "bun";
import { topicCapabilityDeps } from "./capability.ts";

export interface TopicPagePost {
  readonly id: string;
  readonly position: number;
  readonly href: string;
  readonly authorCard: SafeHtml;
  readonly body: SafeHtml;
  readonly deleted: boolean;
  readonly unapproved: boolean;
  readonly createdAt: string;
  readonly editedMarker: string | null;
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
}

export interface TopicPageData {
  readonly viewModel: TopicPageView;
  readonly breadcrumbs: readonly { readonly label: string; readonly href: string | null }[];
  readonly visibilityKey: string;
  readonly hasUnlockGrant: boolean;
  readonly page: number;
  readonly pageCount: number;
  readonly memberIds: readonly string[];
  readonly quoteTopicIds: readonly string[];
  readonly quotePostIds: readonly string[];
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
  const rendered = await Promise.all(
    posts.rows.map(async (post) => {
      const current = await ensureCurrentRendering(
        {
          bodyHtml: post.bodyHtml,
          bodyText: post.bodyText,
          renderVersion: post.renderVersion,
          sanitiserVersion: post.sanitiserVersion,
        },
        { profile: "post", embedProviders, mentions: mentionsEnabled },
      );

      return { post, html: current.bodyHtml };
    }),
  );
  const sourceIds = [...new Set(rendered.flatMap((entry) => quoteSourceIds(entry.html)))];
  const sources = await loadQuoteSources(input.sql, sourceIds);
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
        source.authorId !== input.principal &&
        !seeUnapproved
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
  const visibleForums = await listVisibleForums(input.sql, view);
  const visibleById = new Map(visibleForums.map((forum) => [forum.id, forum]));
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
  const memberIds = posts.rows.flatMap((post) => (post.authorId === null ? [] : [post.authorId]));

  return {
    breadcrumbs,
    visibilityKey: view.visibilityKey(),
    hasUnlockGrant: view.hasUnlockGrant,
    page,
    pageCount,
    memberIds,
    quoteTopicIds,
    quotePostIds,
    viewModel: {
      topicId: input.topic.id,
      forumId: input.topic.forumId,
      title: input.topic.title,
      href: canonicalUrl("topic", input.topic.id, input.topic.slug),
      prefix:
        input.topic.prefixId === null
          ? null
          : await readTopicPrefix(input.sql, input.topic.prefixId, input.locale),
      pinned: input.topic.pinned,
      locked: input.topic.locked,
      isModerator,
      replyCount: input.translate("index.topicReplies", { count: input.topic.replyCount }),
      posts: posts.rows.map((post, index) => ({
        id: post.id,
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
        body: safeHtml(bodies[index] ?? post.bodyHtml),
        deleted: post.visibility === "soft_deleted",
        unapproved: post.visibility === "unapproved",
        createdAt: formatDate(input.locale, post.createdAt),
        editedMarker: editedMarker(input, post),
      })),
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
      flags: { mentions: mentionsEnabled },
    },
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
