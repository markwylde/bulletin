import { forumTag, GLOBAL_CACHE_TAGS, memberTag } from "@bulletin/cache";
import { readBoardSettings } from "@bulletin/domain/board";
import {
  type FeedDocument,
  type FeedTopicRecord,
  guestSeoAvailable,
  loadGuestSeoAccess,
  readBoardFeed,
  readForumFeed,
  readGuestFeedForum,
  renderAtomFeed,
  renderRssFeed,
} from "@bulletin/domain/seo";
import { canonicalUrl, parseResourcePath, slugify } from "@bulletin/domain/urls";
import { createServerT, type Locale, type Translator } from "@bulletin/i18n";
import type { SQL } from "bun";
import { USER_CATALOGS } from "../catalogs.ts";
import { notFoundDocument, type SeoDocument, unavailableDocument } from "./document.ts";

export const FEED_FORMATS = ["rss", "atom"] as const;
export type FeedFormat = (typeof FEED_FORMATS)[number];

const FEED_CONTENT_TYPES: Readonly<Record<FeedFormat, string>> = {
  rss: "application/rss+xml; charset=utf-8",
  atom: "application/atom+xml; charset=utf-8",
};

export function feedPath(
  format: FeedFormat,
  forum?: { readonly id: string; readonly slug: string },
) {
  const extension = format === "rss" ? "xml" : "atom";

  return forum === undefined
    ? `/feed.${extension}`
    : `/feed/forum/${forum.id}-${slugify(forum.slug)}.${extension}`;
}

function feedDescription(
  translate: Translator,
  kind: "board" | "forum",
  values: Readonly<Record<string, string>>,
): string {
  return kind === "board"
    ? translate("seo.feed.board.description", values)
    : translate("seo.feed.forum.description", values);
}

function feedTitle(
  translate: Translator,
  kind: "board" | "forum",
  values: Readonly<Record<string, string>>,
): string {
  return kind === "board"
    ? translate("seo.feed.board.title", values)
    : translate("seo.feed.forum.title", values);
}

function feedDocument(input: {
  readonly format: FeedFormat;
  readonly title: string;
  readonly description: string;
  readonly link: string;
  readonly selfLink: string;
  readonly locale: Locale;
  readonly boardName: string;
  readonly topics: readonly FeedTopicRecord[];
  readonly origin: string;
}): string {
  const items = input.topics.map((topic) => {
    const link = `${input.origin}${canonicalUrl("topic", topic.id, topic.slug)}`;

    return {
      title: topic.title,
      link,
      publishedAt: topic.createdAt,
      updatedAt: topic.lastPostAt,
      authorName: topic.authorName,
      excerpt: topic.excerpt,
    };
  });
  const document: FeedDocument = {
    title: input.title,
    link: input.link,
    selfLink: input.selfLink,
    description: input.description,
    language: input.locale,
    updatedAt: input.topics[0]?.lastPostAt ?? new Date(0),
    authorName: input.boardName,
    items,
  };

  return input.format === "rss" ? renderRssFeed(document) : renderAtomFeed(document);
}

/**
 * Feeds publish author display names, so each listed author's `member:{id}` tag is on the
 * document: a rename or an erasure (which bumps and CDN-purges that tag) refreshes it at once
 * instead of waiting for the 30 s guest cache window (ADR 0006, 0012).
 */
function authorTags(topics: readonly FeedTopicRecord[]): readonly string[] {
  return [
    ...new Set(
      topics.flatMap((topic) => (topic.authorId === null ? [] : [memberTag(topic.authorId)])),
    ),
  ];
}

/**
 * The board or per-forum feed. A forum guests cannot read, a password forum and a redirect
 * forum all answer 404, exactly like the forum page's denial (spec: Private forum feed).
 */
export async function feedDocumentFor(input: {
  readonly sql: SQL;
  readonly origin: string;
  readonly format: FeedFormat;
  readonly forumRef?: string | null;
}): Promise<SeoDocument> {
  if (!(await guestSeoAvailable(input.sql))) {
    return unavailableDocument();
  }

  const access = await loadGuestSeoAccess(input.sql);
  const settings = await readBoardSettings(input.sql);
  const translate = createServerT(settings.defaultLocale, { shipped: USER_CATALOGS });
  const boardName =
    settings.boardName.trim() === "" ? translate("common.siteName") : settings.boardName;
  const forumId =
    input.forumRef === undefined || input.forumRef === null ? null : parseForumRef(input.forumRef);

  if (forumId === null && input.forumRef !== undefined && input.forumRef !== null) {
    return notFoundDocument();
  }

  if (forumId === null) {
    const topics = await readBoardFeed(input.sql, access);
    const selfLink = `${input.origin}${feedPath(input.format)}`;

    return {
      status: 200,
      body: feedDocument({
        format: input.format,
        title: feedTitle(translate, "board", { board: boardName }),
        description: feedDescription(translate, "board", { board: boardName }),
        link: `${input.origin}/`,
        selfLink,
        locale: settings.defaultLocale,
        boardName,
        topics,
        origin: input.origin,
      }),
      contentType: FEED_CONTENT_TYPES[input.format],
      tags: [
        GLOBAL_CACHE_TAGS.perm,
        GLOBAL_CACHE_TAGS.board,
        ...access.readableForumIds.map(forumTag),
        ...authorTags(topics),
      ],
    };
  }

  const forum = await readGuestFeedForum(input.sql, access, forumId);

  if (forum === null) {
    return notFoundDocument();
  }

  const topics = await readForumFeed(input.sql, access, forum.id);
  const selfLink = `${input.origin}${feedPath(input.format, forum)}`;

  return {
    status: 200,
    body: feedDocument({
      format: input.format,
      title: feedTitle(translate, "forum", { forum: forum.title, board: boardName }),
      description: feedDescription(translate, "forum", { forum: forum.title, board: boardName }),
      link: `${input.origin}${canonicalUrl("forum", forum.id, forum.slug)}`,
      selfLink,
      locale: settings.defaultLocale,
      boardName,
      topics,
      origin: input.origin,
    }),
    contentType: FEED_CONTENT_TYPES[input.format],
    tags: [
      GLOBAL_CACHE_TAGS.perm,
      GLOBAL_CACHE_TAGS.board,
      ...access.tree.ancestors(forum.id).map((node) => forumTag(node.id)),
      forumTag(forum.id),
      ...authorTags(topics),
    ],
  };
}

function parseForumRef(ref: string): string | null {
  const parsed = parseResourcePath(`/forum/${ref}`);

  return parsed === null || parsed.kind !== "forum" ? null : String(parsed.id);
}
