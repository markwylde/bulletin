import { forumTag, GLOBAL_CACHE_TAGS } from "@bulletin/cache";
import {
  loadGuestSeoAccess,
  readSitemapBounds,
  readSitemapForumPage,
  readSitemapMemberPage,
  readSitemapTopicPage,
  renderSitemapIndex,
  renderSitemapUrlset,
  sitemapPageCount,
} from "@bulletin/domain/seo";
import { canonicalUrl } from "@bulletin/domain/urls";
import type { SQL } from "bun";
import { notFoundDocument, type SeoDocument, SITEMAP_CONTENT_TYPE } from "./document.ts";

export const SITEMAP_KINDS = ["forums", "topics", "members"] as const;
export type SitemapKind = (typeof SITEMAP_KINDS)[number];

export function sitemapPath(kind: SitemapKind, page: number): string {
  return `/sitemap/${kind}/${page}.xml`;
}

function sitemapTags(forumIds: readonly string[]): readonly string[] {
  return [GLOBAL_CACHE_TAGS.perm, ...new Set(forumIds.map(forumTag))];
}

/**
 * The sitemap index advertises one file per 10,000 public IDs. Guests only: the counts and
 * every child file are computed from the Guests permission snapshot (design).
 */
export async function sitemapIndexDocument(input: {
  readonly sql: SQL;
  readonly origin: string;
}): Promise<SeoDocument> {
  const access = await loadGuestSeoAccess(input.sql);
  const bounds = await readSitemapBounds(input.sql, access);
  const entries: Array<{ readonly loc: string }> = [];

  for (const kind of SITEMAP_KINDS) {
    const pages = sitemapPageCount(bounds[kind]);

    for (let page = 1; page <= pages; page += 1) {
      entries.push({ loc: `${input.origin}${sitemapPath(kind, page)}` });
    }
  }

  return {
    status: 200,
    body: renderSitemapIndex(entries),
    contentType: SITEMAP_CONTENT_TYPE,
    tags: [
      ...sitemapTags(access.readableForumIds),
      ...(sitemapPageCount(bounds.members) > 0 ? [GLOBAL_CACHE_TAGS.directory] : []),
    ],
  };
}

/** One keyset-paginated sitemap file; an out-of-range page is a 404, never an empty file. */
export async function sitemapPageDocument(input: {
  readonly sql: SQL;
  readonly origin: string;
  readonly kind: SitemapKind;
  readonly page: number;
}): Promise<SeoDocument> {
  const access = await loadGuestSeoAccess(input.sql);
  const bounds = await readSitemapBounds(input.sql, access);

  if (input.page < 1 || input.page > sitemapPageCount(bounds[input.kind])) {
    return notFoundDocument();
  }

  if (input.kind === "forums") {
    const forums = await readSitemapForumPage(input.sql, access, input.page);

    return {
      status: 200,
      body: renderSitemapUrlset(
        forums.map((forum) => ({
          loc: `${input.origin}${canonicalUrl("forum", forum.id, forum.slug)}`,
          lastmod: forum.lastPostAt,
        })),
      ),
      contentType: SITEMAP_CONTENT_TYPE,
      tags: sitemapTags(forums.map((forum) => forum.id)),
    };
  }

  if (input.kind === "topics") {
    const topics = await readSitemapTopicPage(input.sql, access, input.page);

    return {
      status: 200,
      body: renderSitemapUrlset(
        topics.map((topic) => ({
          loc: `${input.origin}${canonicalUrl("topic", topic.id, topic.slug)}`,
          lastmod: topic.lastPostAt,
        })),
      ),
      contentType: SITEMAP_CONTENT_TYPE,
      tags: sitemapTags(topics.map((topic) => topic.forumId)),
    };
  }

  const members = await readSitemapMemberPage(input.sql, input.page);

  return {
    status: 200,
    body: renderSitemapUrlset(
      members.map((member) => ({
        loc: `${input.origin}${canonicalUrl("profile", member.id, member.displayName)}`,
      })),
    ),
    contentType: SITEMAP_CONTENT_TYPE,
    tags: [GLOBAL_CACHE_TAGS.perm, GLOBAL_CACHE_TAGS.directory],
  };
}
