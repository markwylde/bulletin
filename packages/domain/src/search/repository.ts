import type { SQL } from "bun";
import type { CapabilityView } from "../permissions/capability.ts";
import type { SearchConfig } from "./language.ts";
import {
  BODY_SNIPPET_OPTIONS,
  renderSearchSnippet,
  SNIPPET_GT,
  SNIPPET_LT,
  TITLE_SNIPPET_OPTIONS,
} from "./snippet.ts";
import {
  type PostSearchHit,
  SEARCH_RESULT_CAP,
  type SearchSort,
  type TopicSearchHit,
} from "./types.ts";

export interface SearchRepositoryInput {
  readonly query: string;
  /** The viewer's locale config, ORed with `simple` (ADR 0017). */
  readonly queryConfig: SearchConfig;
  /** Every forum bit the query filters by comes from this accessor (ADR 0005). */
  readonly capability: CapabilityView;
  /** Expanded forum filter (the forum and its descendants); null means no forum filter. */
  readonly forumIds: readonly string[] | null;
  readonly authorId: string | null;
  readonly prefixIds: readonly string[] | null;
  readonly createdFrom: Date | null;
  readonly createdTo: Date | null;
  readonly sort: SearchSort;
  readonly limit: number;
  readonly offset: number;
}

export interface SearchClearance {
  readonly readableForumIds: readonly string[];
  readonly seeUnapprovedForumIds: readonly string[];
  readonly seeDeletedForumIds: readonly string[];
}

/** Reads the capability bits once per search; password unlocks are already folded into read. */
export function searchClearance(capability: CapabilityView): SearchClearance {
  const readableForumIds: string[] = [];
  const seeUnapprovedForumIds: string[] = [];
  const seeDeletedForumIds: string[] = [];

  for (const forumId of capability.tree.ids) {
    if (capability.read(forumId)) {
      readableForumIds.push(forumId);
    }

    if (capability.has(forumId, "see_unapproved")) {
      seeUnapprovedForumIds.push(forumId);
    }

    if (capability.has(forumId, "see_deleted")) {
      seeDeletedForumIds.push(forumId);
    }
  }

  return { readableForumIds, seeUnapprovedForumIds, seeDeletedForumIds };
}

interface TopicHitRow {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly forum_id: string;
  readonly forum_slug: string;
  readonly forum_title: string;
  readonly author_id: string | null;
  readonly author_display_name: string | null;
  readonly created_at: Date;
  readonly headline: string;
}

interface PostHitRow {
  readonly id: string;
  readonly topic_id: string;
  readonly title: string;
  readonly slug: string;
  readonly forum_id: string;
  readonly forum_slug: string;
  readonly forum_title: string;
  readonly author_id: string | null;
  readonly author_display_name: string | null;
  readonly created_at: Date;
  readonly position: number;
  readonly headline: string;
}

interface ScoreRow {
  readonly id: string;
  readonly score: number;
}

function bigintArray(ids: readonly string[]): string {
  return `{${ids.join(",")}}`;
}

/** Topic state a viewer may see (ADR 0017): current visibility, never a stale index flag. */
function topicVisibility(sql: SQL, unapproved: string, deleted: string) {
  return sql`(
    topic.visibility = 'visible'
    OR (topic.visibility = 'unapproved' AND topic.forum_id = ANY(${unapproved}::bigint[]))
    OR (topic.visibility = 'soft_deleted' AND topic.forum_id = ANY(${deleted}::bigint[]))
  )`;
}

/** Post state a viewer may see; a held/deleted topic hides its otherwise public replies too. */
function postVisibility(sql: SQL, unapproved: string, deleted: string) {
  return sql`(
    post.visibility = 'visible'
    OR (post.visibility = 'unapproved' AND topic.forum_id = ANY(${unapproved}::bigint[]))
    OR (post.visibility = 'soft_deleted' AND topic.forum_id = ANY(${deleted}::bigint[]))
  )`;
}

function topicScore(sql: SQL) {
  return sql`GREATEST(
    ts_rank_cd(topic.tsv, search_query.stemmed),
    ts_rank_cd(topic.tsv_simple, search_query.simple)
  )::float8 * (
    1.0 / (
      1.0 + GREATEST(
        EXTRACT(EPOCH FROM (now() - COALESCE(topic.last_post_at, topic.created_at))),
        0
      ) / 2592000.0
    )
  )`;
}

function postScore(sql: SQL) {
  return sql`GREATEST(
    ts_rank_cd(post.tsv, search_query.stemmed),
    ts_rank_cd(post.tsv_simple, search_query.simple)
  )::float8 * (
    1.0 / (
      1.0 + GREATEST(EXTRACT(EPOCH FROM (now() - post.created_at)), 0) / 2592000.0
    )
  )`;
}

/** The capped number of matching topics. The cap stops collection, not just display. */
export async function countTopicHits(sql: SQL, input: SearchRepositoryInput): Promise<number> {
  const { readableForumIds, seeUnapprovedForumIds, seeDeletedForumIds } = searchClearance(
    input.capability,
  );
  const readable = bigintArray(readableForumIds);
  const unapproved = bigintArray(seeUnapprovedForumIds);
  const deleted = bigintArray(seeDeletedForumIds);
  const forums = input.forumIds === null ? null : bigintArray(input.forumIds);
  const prefixes = input.prefixIds === null ? null : bigintArray(input.prefixIds);
  const [row] = (await sql`
    WITH search_query AS (
      SELECT
        websearch_to_tsquery(${input.queryConfig}::regconfig, ${input.query}) AS stemmed,
        websearch_to_tsquery('simple', ${input.query}) AS simple
    )
    SELECT count(*)::int AS total
    FROM (
      SELECT 1
      FROM core.topics AS topic
      CROSS JOIN search_query
      WHERE topic.moved_to IS NULL
        AND topic.forum_id = ANY(${readable}::bigint[])
        AND ${topicVisibility(sql, unapproved, deleted)}
        AND (${forums}::bigint[] IS NULL OR topic.forum_id = ANY(${forums}::bigint[]))
        AND (${input.authorId}::bigint IS NULL OR topic.starter_id = ${input.authorId}::bigint)
        AND (${prefixes}::bigint[] IS NULL OR topic.prefix_id = ANY(${prefixes}::bigint[]))
        AND (${input.createdFrom}::timestamptz IS NULL OR topic.created_at >= ${input.createdFrom})
        AND (${input.createdTo}::timestamptz IS NULL OR topic.created_at <= ${input.createdTo})
        AND (topic.tsv @@ search_query.stemmed OR topic.tsv_simple @@ search_query.simple)
      LIMIT ${SEARCH_RESULT_CAP}
    ) AS capped
  `) as Array<{ total: number }>;

  return row?.total ?? 0;
}

export async function searchTopicPage(
  sql: SQL,
  input: SearchRepositoryInput,
): Promise<readonly TopicSearchHit[]> {
  const { readableForumIds, seeUnapprovedForumIds, seeDeletedForumIds } = searchClearance(
    input.capability,
  );
  const readable = bigintArray(readableForumIds);
  const unapproved = bigintArray(seeUnapprovedForumIds);
  const deleted = bigintArray(seeDeletedForumIds);
  const forums = input.forumIds === null ? null : bigintArray(input.forumIds);
  const prefixes = input.prefixIds === null ? null : bigintArray(input.prefixIds);
  const conditions = sql`
    topic.moved_to IS NULL
    AND topic.forum_id = ANY(${readable}::bigint[])
    AND ${topicVisibility(sql, unapproved, deleted)}
    AND (${forums}::bigint[] IS NULL OR topic.forum_id = ANY(${forums}::bigint[]))
    AND (${input.authorId}::bigint IS NULL OR topic.starter_id = ${input.authorId}::bigint)
    AND (${prefixes}::bigint[] IS NULL OR topic.prefix_id = ANY(${prefixes}::bigint[]))
    AND (${input.createdFrom}::timestamptz IS NULL OR topic.created_at >= ${input.createdFrom})
    AND (${input.createdTo}::timestamptz IS NULL OR topic.created_at <= ${input.createdTo})
    AND (topic.tsv @@ search_query.stemmed OR topic.tsv_simple @@ search_query.simple)
  `;
  const rows = (await sql`
    WITH search_query AS (
      SELECT
        websearch_to_tsquery(${input.queryConfig}::regconfig, ${input.query}) AS stemmed,
        websearch_to_tsquery('simple', ${input.query}) AS simple
    )
    SELECT
      topic.id::text AS id,
      ${topicScore(sql)} AS score,
      COALESCE(topic.last_post_at, topic.created_at) AS sort_at
    FROM core.topics AS topic
    CROSS JOIN search_query
    WHERE ${conditions}
    ORDER BY
      ${input.sort === "date" ? sql`sort_at DESC` : sql`score DESC`},
      sort_at DESC,
      id DESC
    LIMIT ${input.limit} OFFSET ${input.offset}
  `) as ScoreRow[];

  if (rows.length === 0) {
    return [];
  }

  const ids = bigintArray(rows.map((row) => row.id));
  const hits = (await sql`
    WITH search_query AS (
      SELECT
        websearch_to_tsquery(${input.queryConfig}::regconfig, ${input.query}) AS stemmed,
        websearch_to_tsquery('simple', ${input.query}) AS simple
    )
    SELECT
      topic.id::text AS id,
      topic.title,
      topic.slug,
      topic.forum_id::text AS forum_id,
      forum.slug AS forum_slug,
      forum.title AS forum_title,
      topic.starter_id::text AS author_id,
      author.display_name AS author_display_name,
      topic.created_at,
      ts_headline(
        'simple',
        replace(replace(topic.title, '<', ${SNIPPET_LT}), '>', ${SNIPPET_GT}),
        (search_query.stemmed || search_query.simple),
        ${TITLE_SNIPPET_OPTIONS}
      ) AS headline
    FROM core.topics AS topic
    JOIN core.forums AS forum ON forum.id = topic.forum_id
    LEFT JOIN core.members AS author ON author.id = topic.starter_id
    CROSS JOIN search_query
    WHERE topic.id = ANY(${ids}::bigint[])
      AND ${conditions}
  `) as TopicHitRow[];
  const byId = new Map(hits.map((hit) => [hit.id, hit]));

  return rows.flatMap((row) => {
    const hit = byId.get(row.id);

    if (hit === undefined) {
      return [];
    }

    return [
      {
        kind: "topic",
        topicId: hit.id,
        topicTitle: hit.title,
        topicSlug: hit.slug,
        forumId: hit.forum_id,
        forumSlug: hit.forum_slug,
        forumTitle: hit.forum_title,
        authorId: hit.author_id,
        authorDisplayName: hit.author_display_name,
        createdAt: new Date(hit.created_at),
        snippet: renderSearchSnippet(hit.headline),
        score: row.score,
      } satisfies TopicSearchHit,
    ];
  });
}

/** The capped number of matching posts. The cap stops collection, not just display. */
export async function countPostHits(sql: SQL, input: SearchRepositoryInput): Promise<number> {
  const { readableForumIds, seeUnapprovedForumIds, seeDeletedForumIds } = searchClearance(
    input.capability,
  );
  const readable = bigintArray(readableForumIds);
  const unapproved = bigintArray(seeUnapprovedForumIds);
  const deleted = bigintArray(seeDeletedForumIds);
  const forums = input.forumIds === null ? null : bigintArray(input.forumIds);
  const prefixes = input.prefixIds === null ? null : bigintArray(input.prefixIds);
  const [row] = (await sql`
    WITH search_query AS (
      SELECT
        websearch_to_tsquery(${input.queryConfig}::regconfig, ${input.query}) AS stemmed,
        websearch_to_tsquery('simple', ${input.query}) AS simple
    )
    SELECT count(*)::int AS total
    FROM (
      SELECT 1
      FROM core.posts AS post
      JOIN core.topics AS topic ON topic.id = post.topic_id
      CROSS JOIN search_query
      WHERE topic.moved_to IS NULL
        AND topic.forum_id = ANY(${readable}::bigint[])
        AND ${topicVisibility(sql, unapproved, deleted)}
        AND ${postVisibility(sql, unapproved, deleted)}
        AND (${forums}::bigint[] IS NULL OR topic.forum_id = ANY(${forums}::bigint[]))
        AND (${input.authorId}::bigint IS NULL OR post.author_id = ${input.authorId}::bigint)
        AND (${prefixes}::bigint[] IS NULL OR topic.prefix_id = ANY(${prefixes}::bigint[]))
        AND (${input.createdFrom}::timestamptz IS NULL OR post.created_at >= ${input.createdFrom})
        AND (${input.createdTo}::timestamptz IS NULL OR post.created_at <= ${input.createdTo})
        AND (post.tsv @@ search_query.stemmed OR post.tsv_simple @@ search_query.simple)
      LIMIT ${SEARCH_RESULT_CAP}
    ) AS capped
  `) as Array<{ total: number }>;

  return row?.total ?? 0;
}

export async function searchPostPage(
  sql: SQL,
  input: SearchRepositoryInput,
): Promise<readonly PostSearchHit[]> {
  const { readableForumIds, seeUnapprovedForumIds, seeDeletedForumIds } = searchClearance(
    input.capability,
  );
  const readable = bigintArray(readableForumIds);
  const unapproved = bigintArray(seeUnapprovedForumIds);
  const deleted = bigintArray(seeDeletedForumIds);
  const forums = input.forumIds === null ? null : bigintArray(input.forumIds);
  const prefixes = input.prefixIds === null ? null : bigintArray(input.prefixIds);
  const conditions = sql`
    topic.moved_to IS NULL
    AND topic.forum_id = ANY(${readable}::bigint[])
    AND ${topicVisibility(sql, unapproved, deleted)}
    AND ${postVisibility(sql, unapproved, deleted)}
    AND (${forums}::bigint[] IS NULL OR topic.forum_id = ANY(${forums}::bigint[]))
    AND (${input.authorId}::bigint IS NULL OR post.author_id = ${input.authorId}::bigint)
    AND (${prefixes}::bigint[] IS NULL OR topic.prefix_id = ANY(${prefixes}::bigint[]))
    AND (${input.createdFrom}::timestamptz IS NULL OR post.created_at >= ${input.createdFrom})
    AND (${input.createdTo}::timestamptz IS NULL OR post.created_at <= ${input.createdTo})
    AND (post.tsv @@ search_query.stemmed OR post.tsv_simple @@ search_query.simple)
  `;
  const rows = (await sql`
    WITH search_query AS (
      SELECT
        websearch_to_tsquery(${input.queryConfig}::regconfig, ${input.query}) AS stemmed,
        websearch_to_tsquery('simple', ${input.query}) AS simple
    )
    SELECT
      post.id::text AS id,
      ${postScore(sql)} AS score,
      post.created_at AS sort_at
    FROM core.posts AS post
    JOIN core.topics AS topic ON topic.id = post.topic_id
    CROSS JOIN search_query
    WHERE ${conditions}
    ORDER BY
      ${input.sort === "date" ? sql`sort_at DESC` : sql`score DESC`},
      sort_at DESC,
      id DESC
    LIMIT ${input.limit} OFFSET ${input.offset}
  `) as ScoreRow[];

  if (rows.length === 0) {
    return [];
  }

  const ids = bigintArray(rows.map((row) => row.id));
  const hits = (await sql`
    WITH search_query AS (
      SELECT
        websearch_to_tsquery(${input.queryConfig}::regconfig, ${input.query}) AS stemmed,
        websearch_to_tsquery('simple', ${input.query}) AS simple
    )
    SELECT
      post.id::text AS id,
      post.topic_id::text AS topic_id,
      topic.title,
      topic.slug,
      topic.forum_id::text AS forum_id,
      forum.slug AS forum_slug,
      forum.title AS forum_title,
      post.author_id::text AS author_id,
      author.display_name AS author_display_name,
      post.created_at,
      post.position,
      ts_headline(
        'simple',
        replace(replace(post.body_text, '<', ${SNIPPET_LT}), '>', ${SNIPPET_GT}),
        (search_query.stemmed || search_query.simple),
        ${BODY_SNIPPET_OPTIONS}
      ) AS headline
    FROM core.posts AS post
    JOIN core.topics AS topic ON topic.id = post.topic_id
    JOIN core.forums AS forum ON forum.id = topic.forum_id
    LEFT JOIN core.members AS author ON author.id = post.author_id
    CROSS JOIN search_query
    WHERE post.id = ANY(${ids}::bigint[])
      AND ${conditions}
  `) as PostHitRow[];
  const byId = new Map(hits.map((hit) => [hit.id, hit]));

  return rows.flatMap((row) => {
    const hit = byId.get(row.id);

    if (hit === undefined) {
      return [];
    }

    return [
      {
        kind: "post",
        postId: hit.id,
        topicId: hit.topic_id,
        topicTitle: hit.title,
        topicSlug: hit.slug,
        forumId: hit.forum_id,
        forumSlug: hit.forum_slug,
        forumTitle: hit.forum_title,
        authorId: hit.author_id,
        authorDisplayName: hit.author_display_name,
        createdAt: new Date(hit.created_at),
        position: hit.position,
        snippet: renderSearchSnippet(hit.headline),
        score: row.score,
      } satisfies PostSearchHit,
    ];
  });
}
