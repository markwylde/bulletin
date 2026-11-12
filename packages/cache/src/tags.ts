import type { SQL } from "bun";

/** The single LISTEN/NOTIFY channel for cache tag versions (ADR 0006). */
export const CACHE_TAG_NOTIFY_CHANNEL = "bulletin_cache_tags";

/**
 * Tags every process cares about without a resource id (ADR 0006). Resource tags are built by
 * the helpers below so every caller spells them the same way.
 */
export const GLOBAL_CACHE_TAGS = {
  /** Permissions, masks, groups and memberships; checked every second as a backstop. */
  perm: "perm",
  flags: "flags",
  plugins: "plugins",
  announcements: "announcements",
  /** Editor emoticon sets: every page that embeds the picker carries this tag. */
  emoticons: "emoticons",
  /** Rank titles/pips: author cards rebuild when a rank rule changes (member-profiles). */
  ranks: "ranks",
  /** Badge definitions: profile and author-card badges rebuild when one changes. */
  badges: "badges",
  /** Custom profile fields: definitions and per-group visibility change every profile. */
  profileFields: "profile_fields",
  /** The member list; a member joins, is hidden or changes name. */
  directory: "member_directory",
  /** Materialised leaderboard entries; the hourly job bumps it in the same transaction. */
  leaderboards: "leaderboards",
  /** Who's online and the board summary: privacy changes invalidate it immediately. */
  online: "online",
  /** The staff-managed reaction set: every reaction bar rebuilds when it changes. */
  reactions: "reactions",
  /** Board name, description, locale and offline state: the shared home shell. */
  board: "board",
  /** Bad-word replace rules: every rendered content fragment rebuilds when they change. */
  filters: "filters",
} as const;

const RESOURCE_ID = /^\d+$/;

function resourceTag(prefix: string, id: string): string {
  if (!RESOURCE_ID.test(id)) {
    throw new Error(`Cache tag ${prefix} needs a numeric id, received "${id}"`);
  }

  return `${prefix}:${id}`;
}

export function forumTag(forumId: string): string {
  return resourceTag("forum", forumId);
}

/** One forum's announcement block; global notices use `GLOBAL_CACHE_TAGS.announcements`. */
export function forumAnnouncementsTag(forumId: string): string {
  return `${forumTag(forumId)}:announcements`;
}

export function topicTag(topicId: string): string {
  return resourceTag("topic", topicId);
}

/** The topic's page fragments, invalidated separately from counters (ADR 0006). */
export function topicPagesTag(topicId: string): string {
  return `${topicTag(topicId)}:pages`;
}

/** The small view-count fragment, refreshed on a timer without invalidating the topic. */
export function topicViewsTag(topicId: string): string {
  return `${topicTag(topicId)}:views`;
}

/**
 * A post's quote snapshots. Redacting a post bumps this tag, so every fragment that quotes
 * it rebuilds without touching the post itself (ADR 0007).
 */
export function postTag(postId: string): string {
  return resourceTag("post", postId);
}

export function postSnapshotsTag(postId: string): string {
  return `${resourceTag("post", postId)}:snapshots`;
}

/**
 * One post's reaction bar. Reactions bump only this tag, so the post body fragment stays valid
 * (ADR 0006; the bar is composed after the post block, like author cards).
 */
export function postReactionsTag(postId: string): string {
  return `${resourceTag("post", postId)}:reactions`;
}

export function pollTag(pollId: string): string {
  return resourceTag("poll", pollId);
}

/** Public poll counts; a vote bumps this so the shared fragment rebuilds (coalesced later). */
export function pollResultsTag(pollId: string): string {
  return `${pollTag(pollId)}:results`;
}

export function memberTag(memberId: string): string {
  return resourceTag("member", memberId);
}

export function themeTag(themeId: string | number): string {
  return resourceTag("theme", String(themeId));
}

export function i18nTag(locale: string): string {
  return `i18n:${locale}`;
}

/** A stale tag is a cache miss: only an entry whose declared versions still match is served. */
export interface TagVersionSource {
  /** The durable version of one tag; missing tags read as "0". */
  version(tag: string): string;
  /** False while the listener is disconnected or late; the cache must then bypass (ADR 0006). */
  isTrusted(): boolean;
  /** The 1 s `perm` backstop; the render cache awaits it before trusting versions. */
  ensurePermFresh?(): Promise<void>;
}

export interface TagVersionRow {
  readonly tag: string;
  readonly version: string;
}

/** Reads durable tag versions; a tag without a row has never been bumped. */
export async function readTagVersions(
  sql: SQL,
  tags?: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const rows = (
    tags === undefined
      ? await sql`SELECT tag, version::text AS version FROM core.cache_tags`
      : await sql`
        SELECT tag, version::text AS version
        FROM core.cache_tags
        WHERE tag = ANY(${`{${tags.join(",")}}`}::text[])
      `
  ) as TagVersionRow[];

  return new Map(rows.map((row) => [row.tag, row.version]));
}

export async function readTagVersion(sql: SQL, tag: string): Promise<string> {
  const rows = (await sql`
    SELECT version::text AS version
    FROM core.cache_tags
    WHERE tag = ${tag}
  `) as Array<{ version: string }>;

  return rows[0]?.version ?? "0";
}

/**
 * Bumps every tag in the caller's transaction and wakes other processes after commit
 * (ADR 0006). This is the only place that writes `core.cache_tags`; the lint rule in tests
 * keeps it that way.
 */
export async function bumpCacheTags(
  sql: SQL,
  tags: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const versions = new Map<string, string>();

  for (const tag of new Set(tags)) {
    const rows = (await sql`
      INSERT INTO core.cache_tags (tag, version, updated_at)
      VALUES (${tag}, 1, now())
      ON CONFLICT (tag) DO UPDATE
        SET version = core.cache_tags.version + 1, updated_at = now()
      RETURNING version::text AS version
    `) as Array<{ version: string }>;
    const version = rows[0]?.version;

    if (version === undefined) {
      throw new Error(`Could not bump cache tag ${tag}`);
    }

    versions.set(tag, version);
    await sql`SELECT pg_notify(${CACHE_TAG_NOTIFY_CHANNEL}, ${tag})`;
  }

  return versions;
}
