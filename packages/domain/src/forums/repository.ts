import type { SQL } from "bun";
import { can } from "../permissions/can.ts";
import type { CapabilityView } from "../permissions/capability.ts";
import type { ViewerPrincipal } from "../permissions/principal.ts";
import type { PermissionSnapshot } from "../permissions/snapshot.ts";
import type { ForumTree } from "../permissions/tree.ts";

export const FORUM_TYPES = ["category", "forum", "redirect"] as const;
export type ForumType = (typeof FORUM_TYPES)[number];

export const FORUM_DEFAULT_SORTS = ["last_post", "start_date", "title"] as const;
export type ForumDefaultSort = (typeof FORUM_DEFAULT_SORTS)[number];

export const FORUM_PREFIX_MODES = ["none", "optional", "required"] as const;
export type ForumPrefixMode = (typeof FORUM_PREFIX_MODES)[number];

/**
 * One category or forum as the reading layer needs it. `path` is the materialised `ltree`
 * rendered as text; the permission compiler builds its own lighter tree from the same rows.
 * IDs are strings because Postgres `bigint` values are read as strings (ADR 0001).
 */
export interface ForumRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly path: string;
  readonly type: ForumType;
  readonly title: string;
  readonly slug: string;
  readonly position: number;
  readonly description: string;
  readonly rules: string;
  readonly rulesHtml: string;
  readonly rulesText: string;
  readonly rulesRenderVersion: number;
  readonly rulesSanitiserVersion: number;
  readonly passwordProtected: boolean;
  readonly redirectUrl: string | null;
  readonly redirectClicks: number;
  readonly showModerators: boolean;
  readonly defaultSort: ForumDefaultSort;
  readonly language: string | null;
  readonly prefixMode: ForumPrefixMode;
  readonly topicCount: number;
  readonly postCount: number;
  readonly lastTopicId: string | null;
  readonly lastPostId: string | null;
  readonly lastPostMemberId: string | null;
  /** The poster's forum display name; public data, joined for the index preview. */
  readonly lastPostMemberName: string | null;
  readonly lastPostAt: Date | null;
}

export type VisibleForum = ForumRecord;

interface ForumRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly path: string;
  readonly type: ForumType;
  readonly title: string;
  readonly slug: string;
  readonly position: number;
  readonly description: string;
  readonly rules: string;
  readonly rules_html: string;
  readonly rules_text: string;
  readonly rules_render_version: number;
  readonly rules_sanitiser_version: number;
  readonly password_protected: boolean;
  readonly redirect_url: string | null;
  readonly redirect_clicks: string;
  readonly show_moderators: boolean;
  readonly default_sort: ForumDefaultSort;
  readonly language: string | null;
  readonly prefix_mode: ForumPrefixMode;
  readonly topic_count: number;
  readonly post_count: number;
  readonly last_topic_id: string | null;
  readonly last_post_id: string | null;
  readonly last_post_member_id: string | null;
  readonly last_post_member_name: string | null;
  readonly last_post_at: Date | null;
}

function toForum(row: ForumRow): ForumRecord {
  return {
    id: row.id,
    parentId: row.parent_id,
    path: row.path,
    type: row.type,
    title: row.title,
    slug: row.slug,
    position: row.position,
    description: row.description,
    rules: row.rules,
    rulesHtml: row.rules_html,
    rulesText: row.rules_text,
    rulesRenderVersion: row.rules_render_version,
    rulesSanitiserVersion: row.rules_sanitiser_version,
    passwordProtected: row.password_protected,
    redirectUrl: row.redirect_url,
    redirectClicks: Number(row.redirect_clicks),
    showModerators: row.show_moderators,
    defaultSort: row.default_sort,
    language: row.language,
    prefixMode: row.prefix_mode,
    topicCount: row.topic_count,
    postCount: row.post_count,
    lastTopicId: row.last_topic_id,
    lastPostId: row.last_post_id,
    lastPostMemberId: row.last_post_member_id,
    lastPostMemberName: row.last_post_member_name,
    lastPostAt: row.last_post_at,
  };
}

/** Sibling order is `position`, then id; path labels are ids and must never drive display order. */
function orderBySiblings(forums: readonly ForumRecord[]): readonly ForumRecord[] {
  const byParent = new Map<string | null, ForumRecord[]>();

  for (const forum of forums) {
    const siblings = byParent.get(forum.parentId) ?? [];
    siblings.push(forum);
    byParent.set(forum.parentId, siblings);
  }

  for (const siblings of byParent.values()) {
    siblings.sort(
      (left, right) => left.position - right.position || left.id.localeCompare(right.id),
    );
  }

  const ordered: ForumRecord[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null): void => {
    for (const forum of byParent.get(parentId) ?? []) {
      if (seen.has(forum.id)) {
        continue;
      }

      seen.add(forum.id);
      ordered.push(forum);
      walk(forum.id);
    }
  };

  walk(null);

  // Defensive: a visible orphan (which the ancestor rule should prevent) still renders once.
  for (const forum of forums) {
    if (!seen.has(forum.id)) {
      ordered.push(forum);
    }
  }

  return ordered;
}

export interface ForumPrefix {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly colour: string;
}

export interface ForumModerator {
  readonly id: string;
  /** The moderating member's or group's ID, for linking to them. */
  readonly targetId: string;
  readonly name: string;
  readonly kind: "member" | "group";
  readonly powers: readonly string[];
}

interface PrefixRow {
  readonly id: string;
  readonly key: string;
  readonly colour: string;
  readonly locale: string | null;
  readonly label: string | null;
}

/** Every prefix enabled on a forum; the caller filters availability through `can()`. */
export async function listForumPrefixes(
  sql: SQL,
  forumId: string,
  locale: string,
): Promise<readonly ForumPrefix[]> {
  const rows = (await sql`
    SELECT p.id, p.key, p.colour, pl.locale, pl.label
    FROM core.forum_prefixes fp
    JOIN core.prefixes p ON p.id = fp.prefix_id
    LEFT JOIN core.prefix_labels pl ON pl.prefix_id = p.id
    WHERE fp.forum_id = ${forumId}
    ORDER BY fp.position, p.display_order, p.id, pl.locale
  `) as PrefixRow[];

  const grouped = new Map<string, { key: string; colour: string; labels: Map<string, string> }>();

  for (const row of rows) {
    const entry = grouped.get(row.id) ?? {
      key: row.key,
      colour: row.colour,
      labels: new Map<string, string>(),
    };

    if (row.locale !== null && row.label !== null) {
      entry.labels.set(row.locale, row.label);
    }

    grouped.set(row.id, entry);
  }

  return [...grouped.entries()].map(([id, entry]) => ({
    id,
    key: entry.key,
    label: entry.labels.get(locale) ?? entry.labels.get("en") ?? entry.key,
    colour: entry.colour,
  }));
}

interface ModeratorRow {
  readonly id: string;
  readonly member_id: string | null;
  readonly group_id: string | null;
  readonly powers: readonly string[];
  readonly forum_id: string;
  readonly member_name: string | null;
  readonly group_title: string | null;
  readonly target_id: string;
}

/** Moderators whose assignment covers this forum, including inherited parent assignments. */
export async function listForumModerators(
  sql: SQL,
  forumId: string,
  ancestorIds: readonly string[],
): Promise<readonly ForumModerator[]> {
  const forumIds = [...new Set([...ancestorIds, forumId])];

  if (forumIds.length === 0) {
    return [];
  }

  const rows = (await sql`
    SELECT m.id, m.member_id, m.group_id, m.powers, m.forum_id,
           member.display_name AS member_name, g.title AS group_title,
           COALESCE(m.member_id, m.group_id)::text AS target_id
    FROM core.moderators m
    LEFT JOIN core.members member ON member.id = m.member_id
    LEFT JOIN core.groups g ON g.id = m.group_id
    WHERE m.forum_id = ANY(${`{${forumIds.join(",")}}`}::bigint[])
      AND (NOT m.this_forum_only OR m.forum_id = ${forumId})
    ORDER BY m.forum_id, m.id
  `) as ModeratorRow[];

  const seen = new Set<string>();

  return rows.flatMap((row) => {
    const name = row.member_id === null ? row.group_title : row.member_name;
    const kind = row.member_id === null ? "group" : "member";
    const key = `${kind}:${name ?? row.id}`;

    if (name === null || seen.has(key)) {
      return [];
    }

    seen.add(key);

    return [{ id: row.id, targetId: row.target_id, name, kind, powers: row.powers }];
  });
}

/** Public redirect counters, refreshed independently of cached page HTML. */
export async function listRedirectClickCounts(sql: SQL): Promise<Readonly<Record<string, number>>> {
  const rows = (await sql`
    SELECT id::text AS id, redirect_clicks::text AS clicks
    FROM core.forums
    WHERE type = 'redirect'
    ORDER BY id
  `) as Array<{ id: string; clicks: string }>;

  return Object.fromEntries(rows.map((row) => [row.id, Number(row.clicks)]));
}

/**
 * The permission-filtered forum repository (ADR 0005). Every content query must live behind a
 * function that takes the viewer's capability accessor; the architecture test fails a build
 * that queries content tables anywhere else.
 */
export async function listVisibleForums(
  sql: SQL,
  capability: CapabilityView,
): Promise<readonly ForumRecord[]> {
  const rows = (await sql`
    SELECT
      f.id, f.parent_id, f.path::text AS path, f.type, f.title, f.slug, f.position,
      f.description, f.rules, f.rules_html, f.rules_text, f.rules_render_version, f.rules_sanitiser_version, (f.password_hash IS NOT NULL) AS password_protected,
      f.redirect_url, f.redirect_clicks::text AS redirect_clicks, f.show_moderators,
      f.default_sort, f.language, f.prefix_mode, f.topic_count, f.post_count,
      f.last_topic_id, f.last_post_id, f.last_post_member_id,
      member.display_name AS last_post_member_name, f.last_post_at
    FROM core.forums f
    LEFT JOIN core.members member ON member.id = f.last_post_member_id
    ORDER BY f.path, f.position, f.id
  `) as ForumRow[];

  return orderBySiblings(rows.filter((row) => capability.has(row.id, "show")).map(toForum));
}

export async function readVisibleForum(
  sql: SQL,
  capability: CapabilityView,
  forumId: string,
): Promise<ForumRecord | null> {
  const rows = (await sql`
    SELECT
      f.id, f.parent_id, f.path::text AS path, f.type, f.title, f.slug, f.position,
      f.description, f.rules, f.rules_html, f.rules_text, f.rules_render_version, f.rules_sanitiser_version, (f.password_hash IS NOT NULL) AS password_protected,
      f.redirect_url, f.redirect_clicks::text AS redirect_clicks, f.show_moderators,
      f.default_sort, f.language, f.prefix_mode, f.topic_count, f.post_count,
      f.last_topic_id, f.last_post_id, f.last_post_member_id,
      member.display_name AS last_post_member_name, f.last_post_at
    FROM core.forums f
    LEFT JOIN core.members member ON member.id = f.last_post_member_id
    WHERE f.id = ${forumId}
  `) as ForumRow[];

  const row = rows[0];

  if (row === undefined || !capability.read(row.id)) {
    return null;
  }

  return toForum(row);
}

/** Loads a forum the viewer may `show`; the caller still checks `read` for its content. */
export async function showVisibleForum(
  sql: SQL,
  capability: CapabilityView,
  forumId: string,
): Promise<ForumRecord | null> {
  const rows = (await sql`
    SELECT
      f.id, f.parent_id, f.path::text AS path, f.type, f.title, f.slug, f.position,
      f.description, f.rules, f.rules_html, f.rules_text, f.rules_render_version, f.rules_sanitiser_version, (f.password_hash IS NOT NULL) AS password_protected,
      f.redirect_url, f.redirect_clicks::text AS redirect_clicks, f.show_moderators,
      f.default_sort, f.language, f.prefix_mode, f.topic_count, f.post_count,
      f.last_topic_id, f.last_post_id, f.last_post_member_id,
      member.display_name AS last_post_member_name, f.last_post_at
    FROM core.forums f
    LEFT JOIN core.members member ON member.id = f.last_post_member_id
    WHERE f.id = ${forumId}
  `) as ForumRow[];

  const row = rows[0];

  if (row === undefined || !capability.has(row.id, "show")) {
    return null;
  }

  return toForum(row);
}

/**
 * Folds buffered redirect clicks into `core.forums.redirect_clicks` (ADR 0006 read-path
 * writes). The caller is the every-minute worker; nothing here bumps a cache tag.
 */
export interface FlushRedirectClicksOptions {
  /** Test seam: runs after the cutoff is chosen but before the buffer is claimed. */
  readonly beforeClaim?: () => Promise<void>;
}

export async function flushRedirectClicks(
  sql: SQL,
  options: FlushRedirectClicksOptions = {},
): Promise<number> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('bulletin.redirect_clicks'))`;

    const [max] = (await tx`
      SELECT coalesce(max(id), 0)::text AS max FROM core.forum_redirect_clicks
    `) as Array<{ max: string }>;
    const cutoff = max?.max ?? "0";

    if (cutoff === "0") {
      return 0;
    }

    if (options.beforeClaim !== undefined) {
      await options.beforeClaim();
    }

    // Claim and aggregate in one statement. Counting first and deleting afterwards can drop
    // lower-id rows that commit between the two statements: they would be deleted without ever
    // being counted. `DELETE … RETURNING` only returns the rows it actually removed.
    const rows = (await tx`
      WITH removed AS (
        DELETE FROM core.forum_redirect_clicks
        WHERE id <= ${cutoff}
        RETURNING forum_id
      )
      SELECT forum_id, count(*)::int AS count
      FROM removed
      GROUP BY forum_id
    `) as Array<{ forum_id: string; count: number }>;

    let total = 0;

    for (const row of rows) {
      await tx`
        UPDATE core.forums
        SET redirect_clicks = redirect_clicks + ${row.count}
        WHERE id = ${row.forum_id}
      `;
      total += row.count;
    }

    return total;
  });
}

export interface BoardStatistics {
  readonly topics: number;
  readonly posts: number;
  readonly members: number;
  readonly newestMember: { readonly id: string; readonly displayName: string } | null;
  readonly recordOnline: { readonly count: number; readonly at: Date | null };
}

export interface BoardStatisticsScope {
  readonly principal: ViewerPrincipal;
  readonly sessionId: string | null;
  readonly tree: ForumTree;
  readonly snapshot: PermissionSnapshot;
}

/**
 * Counts and the online record for the board index (task 4.3). Forum counters are summed only
 * over forums the viewer may read, so private-forum activity never leaks through totals.
 */
export async function readBoardStatistics(
  sql: SQL,
  scope?: BoardStatisticsScope,
): Promise<BoardStatistics> {
  let readableForums: string[] | null = null;

  if (scope !== undefined) {
    readableForums = [];

    for (const forumId of scope.tree.ids) {
      if (
        await can(sql, scope.principal, "read", {
          forumId,
          tree: scope.tree,
          sessionId: scope.sessionId,
          snapshot: scope.snapshot,
        })
      ) {
        readableForums.push(forumId);
      }
    }
  }

  const [counts] = (await sql`
    SELECT
      COALESCE(sum(topic_count), 0)::int AS topics,
      COALESCE(sum(post_count), 0)::int AS posts
    FROM core.forums
    WHERE ${readableForums === null ? sql`true` : sql`id = ANY(${`{${readableForums.join(",")}}`}::bigint[])`}
  `) as Array<{ topics: number; posts: number }>;
  const [members] = (await sql`
    SELECT count(*)::int AS count
    FROM core.members
    WHERE is_service = false AND state = 'active' AND display_name IS NOT NULL
  `) as Array<{ count: number }>;
  const [newest] = (await sql`
    SELECT id::text AS id, display_name
    FROM core.members
    WHERE is_service = false AND state = 'active' AND display_name IS NOT NULL
    ORDER BY joined_at DESC, id DESC
    LIMIT 1
  `) as Array<{ id: string; display_name: string }>;
  const [board] = (await sql`
    SELECT record_online_count, record_online_at FROM core.board_settings WHERE id = 1
  `) as Array<{ record_online_count: number; record_online_at: Date | null }>;

  return {
    topics: counts?.topics ?? 0,
    posts: counts?.posts ?? 0,
    members: members?.count ?? 0,
    newestMember: newest === undefined ? null : { id: newest.id, displayName: newest.display_name },
    recordOnline: {
      count: board?.record_online_count ?? 0,
      at:
        board?.record_online_at === null || board?.record_online_at === undefined
          ? null
          : new Date(board.record_online_at),
    },
  };
}
