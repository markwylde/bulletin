import type { SQL } from "bun";
import type { SeedModule } from "./framework.ts";

async function memberId(sql: SQL, sub: string): Promise<string> {
  const [row] = (await sql`
    SELECT member_id::text AS member_id FROM pii.identities WHERE sub = ${sub}
  `) as Array<{ member_id: string }>;

  if (row === undefined) {
    throw new Error(`Missing seed member ${sub}`);
  }

  return row.member_id;
}

async function forumId(sql: SQL, slug: string): Promise<string> {
  const [row] = (await sql`
    SELECT id::text AS id FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing seed forum ${slug}`);
  }

  return row.id;
}

interface TopicSeed {
  readonly id: string;
  readonly forumId: string;
  readonly firstPostId: string | null;
  readonly lastPostId: string | null;
}

async function topic(sql: SQL, title: string): Promise<TopicSeed> {
  const [row] = (await sql`
    SELECT
      id::text AS id,
      forum_id::text AS forum_id,
      first_post_id::text AS first_post_id,
      last_post_id::text AS last_post_id
    FROM core.topics
    WHERE title = ${title}
    LIMIT 1
  `) as Array<{
    id: string;
    forum_id: string;
    first_post_id: string | null;
    last_post_id: string | null;
  }>;

  if (row === undefined) {
    throw new Error(`Missing seed topic ${title}`);
  }

  return {
    id: row.id,
    forumId: row.forum_id,
    firstPostId: row.first_post_id,
    lastPostId: row.last_post_id,
  };
}

/**
 * Follows, notification centre entries, digest cadences and one non-default preference so a
 * fresh `docker compose up --watch` shows the bell, the list and the preferences page populated
 * (tasks 5.2; ADR 0011, ADR 0012).
 */
export const notificationsSeedModule: SeedModule = {
  name: "notifications",
  dependsOn: ["members", "topics"],
  async run({ sql }) {
    const memberOne = await memberId(sql, "member-1");
    const memberTwo = await memberId(sql, "member-2");
    const memberEs = await memberId(sql, "member-es");
    const memberFr = await memberId(sql, "member-fr");
    const offTopic = await forumId(sql, "off-topic");
    const support = await forumId(sql, "support");
    const reading = await topic(sql, "What are you reading this month?");
    const desks = await topic(sql, "Show us your desk setup");
    const weekend = await topic(sql, "Weekend plans");

    for (const follow of [
      { member: memberOne, kind: "topic", target: reading.id },
      { member: memberOne, kind: "forum", target: offTopic },
      { member: memberOne, kind: "member", target: memberTwo },
      { member: memberTwo, kind: "topic", target: desks.id },
      { member: memberTwo, kind: "member", target: memberOne },
      { member: memberEs, kind: "topic", target: reading.id },
      { member: memberFr, kind: "forum", target: support },
      { member: memberFr, kind: "member", target: memberOne },
    ] as const) {
      if (follow.kind === "topic") {
        await sql`
          INSERT INTO core.followed_topics (member_id, topic_id)
          VALUES (${follow.member}, ${follow.target})
          ON CONFLICT DO NOTHING
        `;
      } else if (follow.kind === "forum") {
        await sql`
          INSERT INTO core.followed_forums (member_id, forum_id)
          VALUES (${follow.member}, ${follow.target})
          ON CONFLICT DO NOTHING
        `;
      } else {
        await sql`
          INSERT INTO core.followed_members (follower_id, followed_id)
          VALUES (${follow.member}, ${follow.target})
          ON CONFLICT DO NOTHING
        `;
      }
    }

    const notifications = [
      {
        member: memberOne,
        type: "topic.reply",
        actor: memberTwo,
        topic: reading,
        post: reading.lastPostId,
        count: 3,
        read: false,
        age: "10 minutes",
      },
      {
        member: memberOne,
        type: "post.mention",
        actor: memberTwo,
        topic: desks,
        post: desks.lastPostId,
        count: 1,
        read: false,
        age: "1 hour",
      },
      {
        member: memberOne,
        type: "member.promoted",
        actor: null,
        topic: null,
        post: null,
        count: 1,
        read: true,
        age: "3 days",
      },
      {
        member: memberTwo,
        type: "post.quote",
        actor: memberOne,
        topic: reading,
        post: reading.lastPostId,
        count: 1,
        read: false,
        age: "2 hours",
      },
      {
        member: memberEs,
        type: "topic.reply",
        actor: memberTwo,
        topic: reading,
        post: reading.lastPostId,
        count: 2,
        read: false,
        age: "20 minutes",
      },
      {
        member: memberFr,
        type: "topic.created",
        actor: memberOne,
        topic: weekend,
        post: weekend.firstPostId,
        count: 1,
        read: false,
        age: "5 hours",
      },
    ] as const;

    for (const entry of notifications) {
      await sql`
        INSERT INTO core.notifications (
          member_id, type, actor_id, topic_id, forum_id, post_id, count, read_at,
          created_at, updated_at
        ) VALUES (
          ${entry.member}, ${entry.type}, ${entry.actor},
          ${entry.topic?.id ?? null}, ${entry.topic?.forumId ?? null}, ${entry.post},
          ${entry.count},
          ${entry.read ? sql`now() - interval '2 days'` : null},
          now() - ${entry.age}::interval,
          now() - ${entry.age}::interval
        )
        ON CONFLICT DO NOTHING
      `;
    }

    // A member with more than one page of history, so the notification centre's Next link and
    // the pagination E2E have real entries to page through (page size is 50).
    await sql`
      INSERT INTO core.notifications (
        member_id, type, actor_id, topic_id, forum_id, post_id, count, read_at,
        created_at, updated_at
      )
      SELECT
        ${memberTwo}, 'topic.reply', ${memberOne}, ${reading.id}, ${reading.forumId},
        ${reading.lastPostId}, 1, now() - (age || ' days')::interval,
        now() - (age || ' days')::interval,
        now() - (age || ' days')::interval
      FROM generate_series(4, 58) AS age
    `;

    for (const [member, frequency] of [
      [memberOne, "weekly"],
      [memberTwo, "daily"],
      [memberFr, "weekly"],
    ] as const) {
      await sql`
        INSERT INTO core.digest_subscriptions (member_id, frequency)
        VALUES (${member}, ${frequency})
        ON CONFLICT (member_id) DO UPDATE SET frequency = EXCLUDED.frequency
      `;
    }

    await sql`
      INSERT INTO core.notification_preferences (member_id, type, channel, enabled)
      VALUES (${memberOne}, 'post.mention', 'email', false)
      ON CONFLICT (member_id, type, channel) DO UPDATE SET enabled = EXCLUDED.enabled
    `;

    // The digest channel is opt-in per type; seed a few so the digest emails have content.
    for (const [member, type] of [
      [memberOne, "topic.reply"],
      [memberOne, "post.mention"],
      [memberTwo, "topic.reply"],
      [memberFr, "topic.created"],
    ] as const) {
      await sql`
        INSERT INTO core.notification_preferences (member_id, type, channel, enabled)
        VALUES (${member}, ${type}, 'digest', true)
        ON CONFLICT (member_id, type, channel) DO UPDATE SET enabled = EXCLUDED.enabled
      `;
    }
  },
};
