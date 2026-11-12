import { renderContent } from "@bulletin/content";
import { textSearchConfig } from "@bulletin/domain/search";
import { slugify } from "@bulletin/domain/urls";
import type { SQL } from "bun";
import type { SeedModule } from "./framework.ts";
import { seedBulkTopics } from "./topics-bulk.ts";

interface SeedReply {
  readonly sub: string;
  readonly body: string;
}

interface SeedPollQuestion {
  readonly prompt: string;
  readonly multiple?: boolean;
  readonly choices: readonly string[];
}

interface SeedPoll {
  readonly resultsVisibleBeforeVoting?: boolean;
  readonly questions: readonly SeedPollQuestion[];
}

interface SeedTopic {
  readonly forumSlug: string;
  readonly title: string;
  readonly authorSub: string;
  readonly pinned?: boolean;
  readonly locked?: boolean;
  readonly poll?: SeedPoll;
  readonly replies: readonly SeedReply[];
}

/**
 * A small, stable topic set so the topic list, topic view and permalinks have real content
 * before the full forum seed lands (task 6.2 builds the large, localised dataset).
 */
const TOPICS: readonly SeedTopic[] = [
  {
    forumSlug: "announcements",
    title: "Welcome to the new Bulletin board",
    authorSub: "admin",
    pinned: true,
    replies: [
      { sub: "member-1", body: "Thanks! The new editor feels great on mobile." },
      { sub: "member-2", body: "Looking forward to the first community event." },
    ],
  },
  {
    forumSlug: "announcements",
    title: "Scheduled maintenance this weekend",
    authorSub: "super-mod",
    locked: true,
    replies: [],
  },
  {
    forumSlug: "off-topic",
    title: "What are you reading this month?",
    authorSub: "member-1",
    replies: [
      { sub: "member-2", body: "A history of the early web. Highly recommended." },
      { sub: "member-es", body: "Estoy leyendo una novela de misterio." },
      { sub: "member-fr", body: "Je relis un classique de science-fiction." },
    ],
  },
  {
    forumSlug: "off-topic",
    title: "Show us your desk setup",
    authorSub: "member-2",
    replies: [{ sub: "member-1", body: "Mechanical keyboard, tiny plant, too much coffee." }],
  },
  {
    forumSlug: "off-topic",
    title: "Weekend plans",
    authorSub: "member-1",
    replies: [],
  },
  {
    forumSlug: "off-topic",
    title: "Poll: what should we read next?",
    authorSub: "member-1",
    poll: {
      questions: [
        {
          prompt: "Which format should the next group read use?",
          choices: ["A novel", "A short story collection", "Non-fiction"],
        },
        {
          prompt: "Which themes interest you?",
          multiple: true,
          choices: ["History", "Science fiction", "Mystery", "Nature"],
        },
      ],
    },
    replies: [],
  },
  {
    forumSlug: "off-topic",
    title: "Long running discussion",
    authorSub: "member-1",
    replies: Array.from({ length: 22 }, (_value, index) => ({
      sub: index % 2 === 0 ? "member-2" : "member-es",
      body: `Reply number ${index + 1} to the long running discussion.`,
    })),
  },
];

async function memberIds(sql: SQL): Promise<Map<string, string>> {
  const rows = (await sql`
    SELECT sub AS key, member_id::text AS id FROM pii.identities
  `) as Array<{ key: string; id: string }>;

  return new Map(rows.map((row) => [row.key, row.id]));
}

async function forumIds(sql: SQL): Promise<Map<string, string>> {
  const rows = (await sql`SELECT slug AS key, id::text AS id FROM core.forums`) as Array<{
    key: string;
    id: string;
  }>;

  return new Map(rows.map((row) => [row.key, row.id]));
}

export const topicsSeedModule: SeedModule = {
  name: "topics",
  dependsOn: ["base", "forums", "groups", "forum-extras", "members"],
  async run(context) {
    const { sql } = context;
    const existing = (await sql`SELECT 1 FROM core.topics LIMIT 1`) as unknown[];

    if (existing.length > 0) {
      return;
    }

    const [members, forums] = await Promise.all([memberIds(sql), forumIds(sql)]);
    const start = Date.now() - 6 * 60 * 60 * 1_000;

    for (const [topicIndex, seed] of TOPICS.entries()) {
      const forumId = forums.get(seed.forumSlug);
      const starterId = members.get(seed.authorSub);

      if (forumId === undefined || starterId === undefined) {
        throw new Error(`Missing seed target for ${seed.title}`);
      }

      const createdAt = new Date(start + topicIndex * 45 * 60 * 1_000);
      const [topic] = (await sql`
        INSERT INTO core.topics (
          forum_id, title, slug, starter_id, lang, pinned, locked, created_at, updated_at
        )
        VALUES (
          ${forumId}, ${seed.title}, ${slugify(seed.title)}, ${starterId},
          ${textSearchConfig("en")}::regconfig, ${seed.pinned ?? false}, ${seed.locked ?? false},
          ${createdAt}, ${createdAt}
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (topic === undefined) {
        throw new Error(`Could not seed topic ${seed.title}`);
      }

      const posts: Array<{ sub: string; body: string }> = [
        { sub: seed.authorSub, body: `${seed.title}\n\nWelcome to the discussion.` },
        ...seed.replies,
      ];
      let firstPostId: string | null = null;
      let lastPostId: string | null = null;
      let lastPostAt = createdAt;
      let lastPostMemberId: string | null = null;

      for (const [index, post] of posts.entries()) {
        const authorId = members.get(post.sub);

        if (authorId === undefined) {
          throw new Error(`Missing seed author ${post.sub}`);
        }

        const rendered = await renderContent(post.body, {
          profile: "post",
          context: { kind: "forum_post", forumId },
          authorId,
        });
        const postedAt = new Date(createdAt.getTime() + index * 7 * 60 * 1_000);
        const [row] = (await sql`
          INSERT INTO core.posts (
            topic_id, author_id, body_md, body_html, body_text, render_version,
            sanitiser_version, position, lang, created_at
          )
          VALUES (
            ${topic.id}, ${authorId}, ${rendered.bodyMd}, ${rendered.bodyHtml},
            ${rendered.bodyText}, ${rendered.renderVersion}, ${rendered.sanitiserVersion},
            ${index + 1}, ${textSearchConfig("en")}::regconfig, ${postedAt}
          )
          RETURNING id::text AS id
        `) as Array<{ id: string }>;

        if (row === undefined) {
          throw new Error(`Could not seed post for ${seed.title}`);
        }

        firstPostId ??= row.id;
        lastPostId = row.id;
        lastPostAt = postedAt;
        lastPostMemberId = authorId;

        await sql`UPDATE core.members SET post_count = post_count + 1 WHERE id = ${authorId}`;
      }

      await sql`
        UPDATE core.topics
        SET first_post_id = ${firstPostId},
            last_post_id = ${lastPostId},
            last_post_at = ${lastPostAt},
            reply_count = ${seed.replies.length}
        WHERE id = ${topic.id}
      `;
      if (seed.poll !== undefined) {
        const [poll] = (await sql`
          INSERT INTO core.polls (topic_id, results_visible_before_voting)
          VALUES (${topic.id}, ${seed.poll.resultsVisibleBeforeVoting === true})
          RETURNING id::text AS id
        `) as Array<{ id: string }>;

        if (poll === undefined) {
          throw new Error(`Could not seed the poll for ${seed.title}`);
        }

        for (const [questionIndex, question] of seed.poll.questions.entries()) {
          const [questionRow] = (await sql`
            INSERT INTO core.poll_questions (poll_id, position, prompt, multiple)
            VALUES (${poll.id}, ${questionIndex}, ${question.prompt}, ${question.multiple === true})
            RETURNING id::text AS id
          `) as Array<{ id: string }>;

          if (questionRow === undefined) {
            throw new Error(`Could not seed the poll question for ${seed.title}`);
          }

          for (const [choiceIndex, label] of question.choices.entries()) {
            await sql`
              INSERT INTO core.poll_choices (poll_id, question_id, position, label)
              VALUES (${poll.id}, ${questionRow.id}, ${choiceIndex}, ${label})
            `;
          }
        }
      }

      await sql`
        UPDATE core.forums
        SET topic_count = topic_count + 1,
            post_count = post_count + ${posts.length},
            last_topic_id = ${topic.id},
            last_post_id = ${lastPostId},
            last_post_member_id = ${lastPostMemberId},
            last_post_at = ${lastPostAt}
        WHERE id = ${forumId}
      `;
    }

    await seedBulkTopics(context, members, forums);
  },
};
