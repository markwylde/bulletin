import type { SeedSize } from "@bulletin/config";
import { renderContent } from "@bulletin/content";
import { displayNameSkeleton } from "@bulletin/domain/member";
import type { SQL } from "bun";
import type { SeedModule } from "./framework.ts";

/**
 * The `SEED_SIZE=large` capacity dataset (ADR 0020): 1M posts and enough authors to drive the
 * nightly load test. Everything is generated set-based from series indexes against a fixed
 * anchor time, so two runs with the same base seed produce identical rows; no clock or random
 * value is read.
 */

export interface CapacityProfile {
  /** Total posts in the database after seeding (the rich base seed counts towards it). */
  readonly posts: number;
  readonly members: number;
  readonly postsPerTopic: number;
}

export const CAPACITY_PROFILES: Readonly<Partial<Record<SeedSize, CapacityProfile>>> = {
  large: { posts: 1_000_000, members: 5_000, postsPerTopic: 20 },
};

/** Fixed time anchor: capacity content is backdated from here, never from `now()`. */
export const CAPACITY_ANCHOR = new Date("2026-01-01T00:00:00.000Z");

/** Forums that only staff can read; capacity content goes to member/guest forums. */
const STAFF_FORUMS = ["staff-room", "moderation-notes"];

const BODIES = [
  "A capacity test post.\n\nIt is long enough to look like a real reply, with a second paragraph that talks about everyday forum things: bookmarks, notifications and a calm inbox.",
  "Another reply in the capacity dataset.\n\n- one point\n- another point\n\nThanks for reading.",
  "Short and sweet: **agreed**, and thanks for sharing the link earlier in the thread.",
] as const;

/** A Postgres array literal; Bun SQL does not bind JS arrays as array parameters. */
function pgArray(values: readonly (string | number)[]): string {
  return `{${values
    .map((value) => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
    .join(",")}}`;
}

export interface CapacityPlan {
  readonly topics: number;
  readonly posts: number;
}

/** How many topics and posts are needed to reach the profile from `existingPosts`. */
export function capacityPlan(profile: CapacityProfile, existingPosts: number): CapacityPlan {
  const posts = Math.max(0, profile.posts - existingPosts);
  return { posts, topics: Math.ceil(posts / profile.postsPerTopic) };
}

async function count(sql: SQL, table: "posts"): Promise<number> {
  const [row] = (await sql.unsafe(`SELECT count(*)::int AS n FROM core.${table}`)) as Array<{
    n: number;
  }>;
  return row?.n ?? 0;
}

async function seedCapacityMembers(sql: SQL, total: number): Promise<string[]> {
  const names = Array.from(
    { length: total },
    (_, index) => `Capacity member ${String(index + 1).padStart(5, "0")}`,
  );
  const skeletons = names.map((name) => displayNameSkeleton(name));
  const joined = names.map((_, index) =>
    new Date(CAPACITY_ANCHOR.getTime() - (total - index) * 3_600_000).toISOString(),
  );

  await sql`
    INSERT INTO core.members (display_name, name_skeleton, joined_at)
    SELECT name, skeleton, joined
    FROM unnest(${pgArray(names)}::text[], ${pgArray(skeletons)}::text[], ${pgArray(joined)}::timestamptz[])
      AS input(name, skeleton, joined)
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO core.member_groups (member_id, group_id, is_primary)
    SELECT m.id, g.id, true
    FROM core.members m
    JOIN core.groups g ON g.key = 'members'
    WHERE m.display_name = ANY(${pgArray(names)}::text[])
    ON CONFLICT DO NOTHING
  `;

  const rows = (await sql`
    SELECT id::text AS id FROM core.members
    WHERE display_name = ANY(${pgArray(names)}::text[])
    ORDER BY id
  `) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

/**
 * Seeds capacity topics and posts until the database holds `profile.posts` posts, then
 * recomputes the topic, forum and member counters for what it added.
 */
export async function seedCapacity(sql: SQL, profile: CapacityProfile): Promise<CapacityPlan> {
  const plan = capacityPlan(profile, await count(sql, "posts"));

  if (plan.posts === 0) {
    return plan;
  }

  const forums = (await sql`
    SELECT id::text AS id FROM core.forums
    WHERE type = 'forum' AND NOT (slug = ANY(${pgArray(STAFF_FORUMS)}::text[]))
    ORDER BY id
  `) as Array<{ id: string }>;

  if (forums.length === 0) {
    throw new Error("The capacity seed needs at least one public forum");
  }

  const members = await seedCapacityMembers(sql, profile.members);
  const rendered = await Promise.all(
    BODIES.map((body) =>
      renderContent(body, {
        profile: "post",
        context: { kind: "forum_post", forumId: forums[0]?.id ?? "1" },
        authorId: members[0] ?? "1",
        emoticons: [],
        embeds: [],
      }),
    ),
  );
  const forumIds = forums.map((forum) => forum.id);

  // Topic g gets posts ((g-1)*ppt, g*ppt]; the last one takes the remainder.
  await sql`
    INSERT INTO core.topics (
      forum_id, title, slug, starter_id, lang, created_at, updated_at
    )
    SELECT
      (${pgArray(forumIds)}::bigint[])[1 + (g - 1) % ${forumIds.length}],
      'Capacity topic ' || g,
      'capacity-topic-' || g,
      (${pgArray(members)}::bigint[])[1 + (g - 1) % ${members.length}],
      'english'::regconfig,
      ${CAPACITY_ANCHOR}::timestamptz - make_interval(mins => (${plan.topics} - g) * 30),
      ${CAPACITY_ANCHOR}::timestamptz - make_interval(mins => (${plan.topics} - g) * 30)
    FROM generate_series(1, ${plan.topics}) AS g
  `;

  const bodyMd = rendered.map((result) => result.bodyMd);
  const bodyHtml = rendered.map((result) => result.bodyHtml);
  const bodyText = rendered.map((result) => result.bodyText);
  const renderVersion = rendered[0]?.renderVersion ?? 1;
  const sanitiserVersion = rendered[0]?.sanitiserVersion ?? 1;

  await sql`
    INSERT INTO core.posts (
      topic_id, author_id, body_md, body_html, body_text, render_version,
      sanitiser_version, position, visibility, lang, created_at
    )
    SELECT
      t.id,
      (${pgArray(members)}::bigint[])[1 + (t.capacity_index * 7 + p) % ${members.length}],
      (${pgArray(bodyMd)}::text[])[1 + (t.capacity_index + p) % 3],
      (${pgArray(bodyHtml)}::text[])[1 + (t.capacity_index + p) % 3],
      (${pgArray(bodyText)}::text[])[1 + (t.capacity_index + p) % 3],
      ${renderVersion},
      ${sanitiserVersion},
      p,
      'visible',
      'english'::regconfig,
      t.created_at + make_interval(secs => (p - 1) * 60)
    FROM (
      SELECT id, created_at, split_part(slug, '-', 3)::int AS capacity_index
      FROM core.topics
      WHERE slug LIKE 'capacity-topic-%'
    ) AS t
    CROSS JOIN LATERAL generate_series(
      1,
      LEAST(
        ${profile.postsPerTopic},
        ${plan.posts} - (t.capacity_index - 1) * ${profile.postsPerTopic}
      )
    ) AS p
    ORDER BY t.capacity_index, p
  `;

  await recountCapacity(sql);
  return plan;
}

async function recountCapacity(sql: SQL): Promise<void> {
  await sql`
    WITH stats AS (
      SELECT
        p.topic_id,
        min(p.id) AS first_id,
        max(p.id) AS last_id,
        count(*) AS posts,
        max(p.created_at) AS last_at
      FROM core.posts p
      JOIN core.topics t ON t.id = p.topic_id
      WHERE t.slug LIKE 'capacity-topic-%' AND p.visibility = 'visible'
      GROUP BY p.topic_id
    )
    UPDATE core.topics t
    SET first_post_id = stats.first_id,
        last_post_id = stats.last_id,
        reply_count = stats.posts - 1,
        last_post_at = stats.last_at,
        updated_at = stats.last_at
    FROM stats
    WHERE t.id = stats.topic_id
  `;
  await sql`
    WITH counts AS (
      SELECT
        t.forum_id,
        count(DISTINCT t.id) FILTER (WHERE t.moved_to IS NULL) AS topics,
        count(p.id) AS posts
      FROM core.topics t
      LEFT JOIN core.posts p ON p.topic_id = t.id AND p.visibility = 'visible'
      GROUP BY t.forum_id
    ),
    latest AS (
      SELECT DISTINCT ON (t.forum_id)
        t.forum_id, t.id AS topic_id, p.id AS post_id, p.author_id, p.created_at
      FROM core.posts p
      JOIN core.topics t ON t.id = p.topic_id
      WHERE p.visibility = 'visible'
      ORDER BY t.forum_id, p.created_at DESC, p.id DESC
    )
    UPDATE core.forums f
    SET topic_count = counts.topics,
        post_count = counts.posts,
        last_topic_id = latest.topic_id,
        last_post_id = latest.post_id,
        last_post_member_id = latest.author_id,
        last_post_at = latest.created_at
    FROM counts
    JOIN latest ON latest.forum_id = counts.forum_id
    WHERE f.id = counts.forum_id
  `;
  await sql`
    WITH counts AS (
      SELECT author_id, count(*)::int AS posts
      FROM core.posts
      WHERE visibility = 'visible' AND author_id IS NOT NULL
      GROUP BY author_id
    )
    UPDATE core.members m
    SET post_count = counts.posts
    FROM counts
    WHERE m.id = counts.author_id
  `;
}

export const capacitySeedModule: SeedModule = {
  name: "capacity",
  dependsOn: ["topics", "members", "forums", "groups"],
  async run({ sql, size }) {
    const profile = CAPACITY_PROFILES[size];

    if (profile !== undefined) {
      await seedCapacity(sql, profile);
    }
  },
};
