import type { RenderCache, RenderStatus, TagVersionSource } from "@bulletin/cache";
import { readBoardSettings } from "@bulletin/domain/board";
import { showVisibleForum } from "@bulletin/domain/forums";
import {
  CapabilityView,
  can,
  GUEST_PRINCIPAL,
  loadForumTree,
  loadPermissionSnapshot,
} from "@bulletin/domain/permissions";
import {
  countTopicPosts,
  loadQuoteSources,
  readQuoteReferencesForPage,
  readTopic,
  readTopicPageOfPost,
  readTopicTarget,
  type TopicRecord,
} from "@bulletin/domain/topics";
import { canonicalUrl, parseResourcePath, resolveResourceUrl } from "@bulletin/domain/urls";
import type { ColorScheme, Locale, Translator } from "@bulletin/i18n";
import { contractTags, type LoadedTheme } from "@bulletin/templates";
import type { SQL } from "bun";
import { topicContract } from "../contracts.ts";
import { loadViewerFlags, type ViewerFlags } from "../flags.ts";
import { etagWithFragments } from "../http/cache.ts";
import { renderPollFragment } from "../polls/fragment.ts";
import { renderReactionBar } from "../reactions/fragment.ts";
import type { UserAppSessionContext } from "../session.ts";
import { pageVariant, renderCachedPage } from "../theme/cached-route.ts";
import { boardNameFrom, loadActiveTheme, renderThemedPage } from "../theme/render.ts";
import { topicCapabilityDeps } from "./capability.ts";
import { renderMemberCards, renderTopicViewsFragment } from "./fragments.ts";
import { buildTopicPage, type TopicPageData } from "./page.ts";
import { renderPostBlock } from "./post-block.ts";

export interface TopicRouteInput {
  readonly sql: SQL;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly session: UserAppSessionContext | null;
  /** The route segment after `/topic/`, e.g. `345-welcome/page/2`. */
  readonly ref: string;
  readonly bench?: number;
  readonly pluginsGeneration: number;
  readonly colourScheme: ColorScheme;
  readonly cache: RenderCache;
  readonly tagVersions?: TagVersionSource | null;
}

interface TopicPageRouteResult {
  readonly kind: "page";
  readonly status: number;
  readonly html: string;
  readonly title: string;
  readonly boardName: string;
  readonly cache: RenderStatus | null;
  readonly variant: string | null;
  readonly tags: readonly string[];
  readonly etag: string | null;
  readonly hasUnlockGrant: boolean;
  readonly errors: readonly string[];
}

interface TopicRedirectRouteResult {
  readonly kind: "redirect";
  readonly status: 301;
  readonly location: string;
  readonly reason: "slug" | "moved";
}

export type TopicRouteResult = TopicPageRouteResult | TopicRedirectRouteResult;

interface TopicRenderData {
  readonly theme: LoadedTheme | null;
  readonly boardName: string;
  readonly title: string;
  readonly page: TopicPageData | null;
  readonly error: { readonly status: 403 | 404 } | null;
  readonly flags: ViewerFlags;
}

async function renderErrorPage(
  input: TopicRouteInput,
  status: 403 | 404,
): Promise<TopicPageRouteResult> {
  const [theme, settings] = await Promise.all([
    loadActiveTheme(input.sql),
    readBoardSettings(input.sql),
  ]);
  const boardName = boardNameFrom(settings.boardName, input.translate);
  const code = status === 404 ? "not_found" : "forbidden";
  const page = await renderThemedPage({
    sql: input.sql,
    boardName,
    locale: input.locale,
    translate: input.translate,
    template: "error",
    viewModel: {
      code,
      message: input.translate(`theme.error.${status === 404 ? "notFound" : "forbidden"}`),
    },
    breadcrumbs: [],
    route: topicContract,
    pluginsGeneration: input.pluginsGeneration,
    theme,
  });

  return {
    kind: "page",
    status,
    html: page.html,
    title: input.translate("theme.error.title"),
    boardName,
    cache: null,
    variant: null,
    tags: [],
    etag: null,
    hasUnlockGrant: false,
    errors: page.errors,
  };
}

function topicThreadUrl(topic: TopicRecord, page: number): string {
  return canonicalUrl("topic", topic.id, topic.slug, { page });
}

function replaceMemberCards(html: string, cards: ReadonlyMap<string, string>): string {
  return html.replace(
    /<bl-member-card data-member="(\d+)"><\/bl-member-card>/g,
    (match, id: string) => cards.get(id) ?? match,
  );
}

/**
 * The `/topic/<id>-<slug>[/page/<n>|/post/<postId>]` route (ADR 0001, 0005, 0006). The page
 * variant carries the viewer's see-deleted/unapproved and moderator bits plus every quoted
 * source forum's read bit; author cards and view counts are composed as separate fragments.
 */
export async function renderTopicRoute(input: TopicRouteInput): Promise<TopicRouteResult> {
  const pathname = input.ref.startsWith("/topic/") ? input.ref : `/topic/${input.ref}`;
  const parsed = parseResourcePath(pathname);

  if (parsed === null || parsed.kind !== "topic") {
    return renderErrorPage(input, 404);
  }

  const topicId = String(parsed.id);
  const topic = await readTopic(input.sql, topicId);

  if (topic === null) {
    return renderErrorPage(input, 404);
  }

  const tree = await loadForumTree(input.sql);
  const principal = input.session?.memberId ?? GUEST_PRINCIPAL;
  const sessionId = input.session?.sessionId ?? null;
  const snapshot = await loadPermissionSnapshot(input.sql, principal, { tree, sessionId });

  if (topic.movedTo !== null) {
    if (topic.stubExpiresAt !== null && topic.stubExpiresAt.getTime() <= Date.now()) {
      return renderErrorPage(input, 404);
    }

    const target = await readTopicTarget(input.sql, topic.movedTo);
    const targetTopic = target === null ? null : await readTopic(input.sql, target.id);
    const sourceReadable = await can(input.sql, principal, "read", {
      forumId: topic.forumId,
      tree,
      sessionId,
      snapshot,
    });
    const targetReadable =
      targetTopic !== null &&
      (await can(input.sql, principal, "read", {
        forumId: targetTopic.forumId,
        tree,
        sessionId,
        snapshot,
      }));
    const targetVisible =
      targetTopic !== null &&
      (await countTopicPosts(input.sql, {
        topicId: targetTopic.id,
        seeUnapproved:
          targetTopic !== null &&
          (await can(input.sql, principal, "see_unapproved", {
            forumId: targetTopic.forumId,
            tree,
            sessionId,
            snapshot,
          })),
        seeDeleted:
          targetTopic !== null &&
          (await can(input.sql, principal, "see_deleted", {
            forumId: targetTopic.forumId,
            tree,
            sessionId,
            snapshot,
          })),
      })) > 0;

    if (!sourceReadable || !targetReadable || !targetVisible || target === null) {
      return renderErrorPage(input, 404);
    }

    return {
      kind: "redirect",
      status: 301,
      location: canonicalUrl("topic", target.id, target.slug),
      reason: "moved",
    };
  }

  const routeView = new CapabilityView({
    ...snapshot,
    deps: topicCapabilityDeps(tree, topic.forumId, []),
    view: "topic-route",
  });
  const forum = await showVisibleForum(input.sql, routeView, topic.forumId);

  if (forum === null) {
    return renderErrorPage(input, 404);
  }

  const readable = await can(input.sql, principal, "read", {
    forumId: forum.id,
    tree,
    sessionId,
    snapshot,
  });

  if (!readable) {
    return renderErrorPage(input, 403);
  }

  const seeUnapproved = await can(input.sql, principal, "see_unapproved", {
    forumId: forum.id,
    tree,
    sessionId,
    snapshot,
  });
  const seeDeleted = await can(input.sql, principal, "see_deleted", {
    forumId: forum.id,
    tree,
    sessionId,
    snapshot,
  });

  if (
    (await countTopicPosts(input.sql, {
      topicId: topic.id,
      seeUnapproved,
      seeDeleted,
    })) === 0
  ) {
    return renderErrorPage(input, 404);
  }

  const slug = resolveResourceUrl(parsed, topic.slug);

  if (slug.status === 301 && slug.location !== null) {
    return { kind: "redirect", status: 301, location: slug.location, reason: "slug" };
  }

  const settings = await readBoardSettings(input.sql);
  const perPage = settings.postsPerPage;

  if (parsed.postId !== null) {
    const position = await readTopicPageOfPost(input.sql, {
      topicId: topic.id,
      postId: String(parsed.postId),
      perPage,
      seeUnapproved,
      seeDeleted,
    });

    if (position === null) {
      return renderErrorPage(input, 404);
    }

    return {
      kind: "redirect",
      status: 301,
      location: `${topicThreadUrl(topic, position.page)}#post-${parsed.postId}`,
      reason: "slug",
    };
  }

  const total = await countTopicPosts(input.sql, {
    topicId: topic.id,
    seeUnapproved,
    seeDeleted,
  });
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const page = Math.max(1, Math.min(parsed.page ?? 1, pageCount));

  if ((parsed.page ?? 1) > pageCount) {
    return { kind: "redirect", status: 301, location: topicThreadUrl(topic, page), reason: "slug" };
  }

  const quoteRefs = await readQuoteReferencesForPage(input.sql, {
    topicId: topic.id,
    limit: perPage,
    offset: (page - 1) * perPage,
    seeUnapproved,
    seeDeleted,
  });
  const quoteSources = await loadQuoteSources(input.sql, quoteRefs.postIds);
  const quoteTopicIds = [...new Set([...quoteSources.values()].map((source) => source.topicId))];
  const quotedForumIds = [
    ...new Set([
      ...quoteRefs.forumIds,
      ...[...quoteSources.values()].map((source) => source.forumId),
    ]),
  ];
  const tags = contractTags(topicContract, {
    topicId: topic.id,
    forumIds: [...tree.ancestors(forum.id).map((node) => node.id), forum.id],
    quoteTopicIds,
    quotePostIds: quoteRefs.postIds,
    quotedForumIds,
  });
  let latest: TopicRenderData | undefined;

  const rendered = await renderCachedPage<TopicRenderData>({
    tags,
    cache: input.cache,
    tagVersions: input.tagVersions ?? null,
    shell: { visitor: input.session === null ? "guest" : "member" },
    prepare: async () => {
      const [theme, freshSettings, flags, freshTree] = await Promise.all([
        loadActiveTheme(input.sql),
        readBoardSettings(input.sql),
        loadViewerFlags(input.sql, input.session),
        loadForumTree(input.sql),
      ]);
      const freshSnapshot = await loadPermissionSnapshot(input.sql, principal, {
        tree: freshTree,
        sessionId,
      });
      const freshTopic = await readTopic(input.sql, topic.id);
      const freshView = new CapabilityView({
        ...freshSnapshot,
        deps: topicCapabilityDeps(freshTree, freshTopic?.forumId ?? topic.forumId, quotedForumIds),
        view: "topic-route",
      });
      const freshForum =
        freshTopic === null
          ? null
          : await showVisibleForum(input.sql, freshView, freshTopic.forumId);
      let pageData: TopicPageData | null = null;
      let error: TopicRenderData["error"] = null;

      if (freshTopic === null || freshForum === null) {
        error = { status: 404 };
      } else {
        const freshReadable = await can(input.sql, principal, "read", {
          forumId: freshForum.id,
          tree: freshTree,
          sessionId,
          snapshot: freshSnapshot,
        });

        if (!freshReadable) {
          error = { status: 403 };
        } else {
          pageData = await buildTopicPage({
            sql: input.sql,
            locale: input.locale,
            translate: input.translate,
            principal,
            sessionId,
            snapshot: freshSnapshot,
            topic: freshTopic,
            page: parsed.page ?? 1,
            perPage: freshSettings.postsPerPage,
            quotedForumIds,
            mentionsEnabled: flags.values.mentions === true,
            pollsEnabled: flags.values.polls === true,
            attachmentsEnabled: flags.values.attachments === true,
            publicEditHistory: freshSettings.publicEditHistory,
          });
        }
      }

      const boardName = boardNameFrom(freshSettings.boardName, input.translate);
      const data: TopicRenderData = {
        theme,
        boardName,
        title: pageData?.viewModel.title ?? input.translate("theme.error.title"),
        page: pageData,
        error,
        flags,
      };

      latest = data;

      return {
        variant: pageVariant({
          route: topicContract.route,
          params: {
            id: topic.id,
            page: pageData?.page ?? page,
            ...(input.bench === undefined || input.bench === 0 ? {} : { bench: input.bench }),
          },
          visibilityKey: pageData?.visibilityKey ?? `error:${freshView.visibilityKey()}`,
          theme,
          pluginsGeneration: input.pluginsGeneration,
          locale: input.locale,
          colourScheme: input.colourScheme,
          renderFlagsHash: flags.hash,
        }),
        data,
      };
    },
    render: async (data) => {
      const page = await renderThemedPage({
        sql: input.sql,
        boardName: data.boardName,
        locale: input.locale,
        translate: input.translate,
        template: data.error === null ? topicContract.templates.page : "error",
        viewModel:
          data.error === null
            ? {
                ...(data.page?.viewModel ?? {}),
                flags: { ...(data.page?.viewModel.flags ?? {}), ...data.flags.values },
              }
            : {
                code: data.error.status === 404 ? "not_found" : "forbidden",
                message: input.translate(
                  `theme.error.${data.error.status === 404 ? "notFound" : "forbidden"}`,
                ),
                flags: data.flags.values,
              },
        breadcrumbs: data.error === null ? (data.page?.breadcrumbs ?? []) : [],
        route: topicContract,
        pluginsGeneration: input.pluginsGeneration,
        theme: data.theme,
      });

      return { html: page.html, errors: page.errors };
    },
  });

  if (latest === undefined) {
    throw new Error("The topic route prepared no view model");
  }

  let html = rendered.html;
  let fragmentState: readonly string[] = [];

  const pageData = latest.page;

  if (pageData !== null) {
    const postBlocks = new Map<string, string>();
    await Promise.all(
      pageData.viewModel.posts.map(async (post) => {
        const html = await renderPostBlock({
          sql: input.sql,
          cache: input.cache,
          theme: latest?.theme ?? null,
          post,
          loadPost: pageData.loadPost,
          visibilityKey: latest?.page?.visibilityKey ?? "",
          locale: input.locale,
          translate: input.translate,
          pluginsGeneration: input.pluginsGeneration,
          colourScheme: input.colourScheme,
          flagsHash: latest?.flags.hash ?? "",
          flags: latest?.flags.values ?? {},
          tags: [
            ...(latest?.page?.postTags.get(post.id) ?? []),
            ...(latest?.page?.allPostTags ?? []),
          ],
        });
        postBlocks.set(post.id, html);
      }),
    );
    const [views, cards, poll] = await Promise.all([
      renderTopicViewsFragment(input.sql, input.cache, topic.id, input.locale, input.translate),
      renderMemberCards(
        input.sql,
        input.cache,
        pageData.memberIds,
        input.locale,
        input.translate,
        latest?.flags.clientFlags.avatar_upload === true,
      ),
      pageData.pollId === null
        ? Promise.resolve(null)
        : renderPollFragment(
            input.sql,
            input.cache,
            pageData.pollId,
            input.locale,
            input.translate,
          ),
    ]);
    const reactionBars = new Map<string, string>();
    await Promise.all(
      pageData.viewModel.posts.map(async (post) => {
        reactionBars.set(
          post.id,
          await renderReactionBar({
            sql: input.sql,
            cache: input.cache,
            postId: post.id,
            locale: input.locale,
            translate: input.translate,
            canReact: pageData.canReact,
          }),
        );
      }),
    );

    html = html.replace("<bl-topic-views></bl-topic-views>", views);
    html = html.replace(
      /<bl-post-block data-post="(\d+)"><\/bl-post-block>/g,
      (match, postId: string) => postBlocks.get(postId) ?? match,
    );
    html = html.replace(
      /<bl-post-reactions data-post="(\d+)"><\/bl-post-reactions>/g,
      (match, postId: string) => reactionBars.get(postId) ?? match,
    );
    html = replaceMemberCards(html, cards);

    if (poll !== null) {
      html = html.replace("<bl-poll></bl-poll>", poll);
    }

    fragmentState = [
      views,
      poll ?? "",
      ...postBlocks.values(),
      ...reactionBars.values(),
      ...pageData.memberIds.map((id) => cards.get(id) ?? ""),
    ];
  }

  return {
    kind: "page",
    status: latest.error?.status ?? 200,
    html,
    title: latest.title,
    boardName: latest.boardName,
    cache: rendered.cache,
    variant: rendered.variant,
    tags: rendered.tags,
    etag: etagWithFragments(rendered.etag, fragmentState),
    hasUnlockGrant: latest.page?.hasUnlockGrant ?? false,
    errors: rendered.errors,
  };
}
