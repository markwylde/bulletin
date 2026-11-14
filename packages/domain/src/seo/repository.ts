import type { SQL } from "bun";
import {
  can,
  GUEST_PRINCIPAL,
  loadPermissionSnapshot,
  type PermissionSnapshot,
} from "../permissions/index.ts";
import type { ForumTree } from "../permissions/tree.ts";
import { loadForumTree } from "../permissions/tree-store.ts";
import { feedExcerpt } from "./xml.ts";

/** Sitemaps hold at most 10,000 URLs; pages are keyset ranges of resource IDs (design). */
export const SITEMAP_URLS_PER_FILE = 10_000;

export interface SeoAccess {
  readonly tree: ForumTree;
  readonly snapshot: PermissionSnapshot;
  /** Forums guests may read and that are not password-protected, ordered by the forum tree. */
  readonly readableForumIds: readonly string[];
}

/**
 * Guest readability of one forum, through `can()` (ADR 0005) with the already loaded Guests
 * snapshot so the check stays O(1). A password forum is never public: its `read` bit needs a
 * session unlock, which a sitemap or feed request never carries.
 */
export async function guestCanReadForum(
  sql: SQL,
  access: Pick<SeoAccess, "tree" | "snapshot">,
  forumId: string,
): Promise<boolean> {
  const forum = access.tree.get(forumId);

  if (forum === undefined || forum.passwordProtected) {
    return false;
  }

  return can(sql, GUEST_PRINCIPAL, "read", {
    forumId,
    tree: access.tree,
    sessionId: null,
    snapshot: access.snapshot,
  });
}

/**
 * Sitemaps and feeds always evaluate as Guests (design): there is no member variant, so a
 * member's request receives exactly the public document and never widens it.
 */
export async function loadGuestSeoAccess(sql: SQL): Promise<SeoAccess> {
  const tree = await loadForumTree(sql);
  const snapshot = await loadPermissionSnapshot(sql, GUEST_PRINCIPAL, { tree, sessionId: null });
  const readableForumIds: string[] = [];

  for (const forumId of tree.ids) {
    if (await guestCanReadForum(sql, { tree, snapshot }, forumId)) {
      readableForumIds.push(forumId);
    }
  }

  return { tree, snapshot, readableForumIds };
}

function idArray(ids: readonly string[]): string {
  return `{${ids.join(",")}}`;
}

function idRange(page: number): { readonly after: string; readonly upTo: string } {
  const perFile = BigInt(SITEMAP_URLS_PER_FILE);
  const index = BigInt(page - 1);

  return { after: String(index * perFile), upTo: String(BigInt(page) * perFile) };
}

/** Number of sitemap files needed to cover every resource up to `maxId`. */
export function sitemapPageCount(maxId: string): number {
  const value = BigInt(maxId);

  if (value <= 0n) {
    return 0;
  }

  return Number((value + BigInt(SITEMAP_URLS_PER_FILE) - 1n) / BigInt(SITEMAP_URLS_PER_FILE));
}

export interface SitemapBounds {
  readonly forums: string;
  readonly topics: string;
  readonly members: string;
}

function maxNumericId(ids: readonly string[]): string {
  let max = 0n;

  for (const id of ids) {
    const value = BigInt(id);

    if (value > max) {
      max = value;
    }
  }

  return String(max);
}

/** Highest public ID per sitemap kind, so the index knows how many pages to advertise. */
export async function readSitemapBounds(sql: SQL, access: SeoAccess): Promise<SitemapBounds> {
  const forums = maxNumericId(access.readableForumIds);
  const [topics] = (await sql`
    SELECT COALESCE(max(t.id), 0)::text AS max
    FROM core.topics t
    WHERE t.forum_id = ANY(${idArray(access.readableForumIds)}::bigint[])
      AND t.visibility = 'visible'
      AND t.moved_to IS NULL
      AND EXISTS (
        SELECT 1 FROM core.posts p
        WHERE p.topic_id = t.id AND p.visibility = 'visible'
      )
  `) as Array<{ max: string }>;
  const [members] = (await sql`
    SELECT COALESCE(max(m.id), 0)::text AS max
    FROM core.members m
    WHERE m.state = 'active'
      AND NOT m.is_service
      AND m.display_name IS NOT NULL
      AND NOT m.hide_from_member_list
  `) as Array<{ max: string }>;

  return { forums, topics: topics?.max ?? "0", members: members?.max ?? "0" };
}

export interface SitemapForumRecord {
  readonly id: string;
  readonly slug: string;
  readonly lastPostAt: Date | null;
}

interface SitemapForumRow {
  readonly id: string;
  readonly slug: string;
  readonly type: string;
  readonly password_protected: boolean;
  readonly last_post_at: Date | null;
}

export async function readSitemapForumPage(
  sql: SQL,
  access: SeoAccess,
  page: number,
): Promise<readonly SitemapForumRecord[]> {
  const range = idRange(page);
  const rows = (await sql`
    SELECT id::text AS id, slug, type, (password_hash IS NOT NULL) AS password_protected,
      last_post_at
    FROM core.forums
    WHERE id > ${range.after}::bigint AND id <= ${range.upTo}::bigint
    ORDER BY id
  `) as SitemapForumRow[];
  const readable = new Set(access.readableForumIds);

  return rows.flatMap((row) =>
    readable.has(row.id) && row.type !== "redirect" && !row.password_protected
      ? [{ id: row.id, slug: row.slug, lastPostAt: row.last_post_at }]
      : [],
  );
}

export interface SitemapTopicRecord {
  readonly id: string;
  readonly slug: string;
  readonly forumId: string;
  readonly lastPostAt: Date | null;
}

interface SitemapTopicRow {
  readonly id: string;
  readonly slug: string;
  readonly forum_id: string;
  readonly last_post_at: Date | null;
}

export async function readSitemapTopicPage(
  sql: SQL,
  access: SeoAccess,
  page: number,
): Promise<readonly SitemapTopicRecord[]> {
  if (access.readableForumIds.length === 0) {
    return [];
  }

  const range = idRange(page);
  const rows = (await sql`
    SELECT t.id::text AS id, t.slug, t.forum_id::text AS forum_id, t.last_post_at
    FROM core.topics t
    WHERE t.forum_id = ANY(${idArray(access.readableForumIds)}::bigint[])
      AND t.id > ${range.after}::bigint
      AND t.id <= ${range.upTo}::bigint
      AND t.visibility = 'visible'
      AND t.moved_to IS NULL
      AND EXISTS (
        SELECT 1 FROM core.posts p
        WHERE p.topic_id = t.id AND p.visibility = 'visible'
      )
    ORDER BY t.id
  `) as SitemapTopicRow[];

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    forumId: row.forum_id,
    lastPostAt: row.last_post_at,
  }));
}

export interface SitemapMemberRecord {
  readonly id: string;
  readonly displayName: string;
}

interface SitemapMemberRow {
  readonly id: string;
  readonly display_name: string;
}

export async function readSitemapMemberPage(
  sql: SQL,
  page: number,
): Promise<readonly SitemapMemberRecord[]> {
  const range = idRange(page);
  const rows = (await sql`
    SELECT m.id::text AS id, m.display_name
    FROM core.members m
    WHERE m.id > ${range.after}::bigint
      AND m.id <= ${range.upTo}::bigint
      AND m.state = 'active'
      AND NOT m.is_service
      AND m.display_name IS NOT NULL
      AND NOT m.hide_from_member_list
    ORDER BY m.id
  `) as SitemapMemberRow[];

  return rows.map((row) => ({ id: row.id, displayName: row.display_name }));
}

export interface FeedForumRecord {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
}

/**
 * The forum a per-forum feed describes, or null when it does not exist, is a redirect, or
 * guests cannot read it (spec: Private forum feed answers 404). Authorised through `can()`.
 */
export async function readGuestFeedForum(
  sql: SQL,
  access: SeoAccess,
  forumId: string,
): Promise<FeedForumRecord | null> {
  if (!/^\d+$/.test(forumId) || !(await guestCanReadForum(sql, access, forumId))) {
    return null;
  }

  const [row] = (await sql`
    SELECT id::text AS id, slug, title, type
    FROM core.forums
    WHERE id = ${forumId}
  `) as Array<{ id: string; slug: string; title: string; type: string }>;

  return row === undefined || row.type === "redirect"
    ? null
    : { id: row.id, slug: row.slug, title: row.title };
}

/** One feed entry: the topic, its first visible post's quote-free text and its forum. */
export interface FeedTopicRecord {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly forumId: string;
  readonly forumSlug: string;
  readonly forumTitle: string;
  /** The starter, so the feed can carry `member:{id}` and erasure/renames purge it. */
  readonly authorId: string | null;
  readonly authorName: string | null;
  readonly createdAt: Date;
  readonly lastPostAt: Date;
  readonly excerpt: string;
}

interface FeedTopicRow {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly forum_id: string;
  readonly forum_slug: string;
  readonly forum_title: string;
  readonly author_id: string | null;
  readonly author_name: string | null;
  readonly created_at: Date;
  readonly last_post_at: Date | null;
  readonly body_text: string | null;
}

const FEED_LIMIT = 20;

async function readFeedTopics(
  sql: SQL,
  input: { readonly readableForumIds: readonly string[]; readonly forumId: string | null },
  limit: number,
): Promise<readonly FeedTopicRecord[]> {
  if (input.readableForumIds.length === 0) {
    return [];
  }

  const rows = (await sql`
    SELECT
      t.id::text AS id,
      t.title,
      t.slug,
      t.forum_id::text AS forum_id,
      forum.slug AS forum_slug,
      forum.title AS forum_title,
      starter.id::text AS author_id,
      starter.display_name AS author_name,
      t.created_at,
      t.last_post_at,
      first_post.body_text
    FROM core.topics t
    JOIN core.forums forum ON forum.id = t.forum_id
    LEFT JOIN core.members starter ON starter.id = t.starter_id
    JOIN LATERAL (
      SELECT p.body_text
      FROM core.posts p
      WHERE p.topic_id = t.id AND p.visibility = 'visible'
      ORDER BY p.position
      LIMIT 1
    ) first_post ON true
    WHERE t.forum_id = ANY(${idArray(input.readableForumIds)}::bigint[])
      AND (${input.forumId}::bigint IS NULL OR t.forum_id = ${input.forumId}::bigint)
      AND t.visibility = 'visible'
      AND t.moved_to IS NULL
    ORDER BY COALESCE(t.last_post_at, t.created_at) DESC, t.id DESC
    LIMIT ${limit}
  `) as FeedTopicRow[];

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    slug: row.slug,
    forumId: row.forum_id,
    forumSlug: row.forum_slug,
    forumTitle: row.forum_title,
    authorId: row.author_id,
    authorName: row.author_name,
    createdAt: row.created_at,
    lastPostAt: row.last_post_at ?? row.created_at,
    excerpt: feedExcerpt(row.body_text ?? ""),
  }));
}

/** The board feed: the 20 most recently active guest-visible topics. */
export async function readBoardFeed(
  sql: SQL,
  access: SeoAccess,
  limit = FEED_LIMIT,
): Promise<readonly FeedTopicRecord[]> {
  return readFeedTopics(sql, { readableForumIds: access.readableForumIds, forumId: null }, limit);
}

/** One forum's feed; the caller has already established that guests may read the forum. */
export async function readForumFeed(
  sql: SQL,
  access: SeoAccess,
  forumId: string,
  limit = FEED_LIMIT,
): Promise<readonly FeedTopicRecord[]> {
  return readFeedTopics(sql, { readableForumIds: access.readableForumIds, forumId }, limit);
}
