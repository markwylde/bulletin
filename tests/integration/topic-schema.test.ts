import { describe, expect, test } from "bun:test";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(
  prefix: string,
  run: (database: TestDatabase) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix }, run);
}

interface Forum {
  readonly id: string;
}

async function createForum(database: TestDatabase): Promise<Forum> {
  const [category] = (await database.sql`
    INSERT INTO core.forums (type, title, slug)
    VALUES ('category', 'Community', 'community')
    RETURNING id
  `) as Array<{ id: string }>;

  if (category === undefined) {
    throw new Error("Could not create the category");
  }

  const [forum] = (await database.sql`
    INSERT INTO core.forums (parent_id, type, title, slug)
    VALUES (${category.id}, 'forum', 'General Discussion', 'general-discussion')
    RETURNING id
  `) as Array<{ id: string }>;

  if (forum === undefined) {
    throw new Error("Could not create the forum");
  }

  return forum;
}

async function createMember(database: TestDatabase, name: string): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name)
    VALUES (${name})
    RETURNING id
  `) as Array<{ id: string }>;
  const id = member?.id;

  if (id === undefined) {
    throw new Error(`Could not create ${name}`);
  }

  return id;
}

async function createTopic(database: TestDatabase, forumId: string, memberId: string) {
  const [topic] = (await database.sql`
    INSERT INTO core.topics (forum_id, title, slug, starter_id)
    VALUES (${forumId}, 'Welcome to the board', 'welcome-to-the-board', ${memberId})
    RETURNING id
  `) as Array<{ id: string }>;

  if (topic === undefined) {
    throw new Error("Could not create the topic");
  }

  const [post] = (await database.sql`
    INSERT INTO core.posts (
      topic_id, author_id, body_md, body_html, body_text, render_version,
      sanitiser_version, position
    )
    VALUES (${topic.id}, ${memberId}, 'Hello **world**', '<p>Hello <strong>world</strong></p>',
      'Hello world', 1, 1, 1)
    RETURNING id
  `) as Array<{ id: string }>;

  if (post === undefined) {
    throw new Error("Could not create the first post");
  }

  await database.sql`
    UPDATE core.topics
    SET first_post_id = ${post.id}, last_post_id = ${post.id}, last_post_at = now()
    WHERE id = ${topic.id}
  `;

  return { topicId: topic.id, postId: post.id };
}

async function expectRejection(query: PromiseLike<unknown>): Promise<void> {
  try {
    await query;
  } catch {
    return;
  }

  throw new Error("Expected the statement to be rejected");
}

function countRows(database: TestDatabase, table: string): Promise<number> {
  return database.sql
    .unsafe(`SELECT count(*)::int AS count FROM ${table}`)
    .then((rows) => (rows as Array<{ count: number }>)[0]?.count ?? 0);
}

integrationDescribe("topics and posts schema", () => {
  test("stores content, revisions, polls and read markers", async () => {
    await withDb("topic_schema", async (database) => {
      const forum = await createForum(database);
      const member = await createMember(database, "Schema Member");
      const { topicId, postId } = await createTopic(database, forum.id, member);

      await database.sql`
        INSERT INTO core.post_revisions (
          post_id, body_md, body_html, body_text, render_version, sanitiser_version,
          editor_id, edited_at
        )
        VALUES (${postId}, 'Hello', '<p>Hello</p>', 'Hello', 1, 1, ${member}, now())
      `;

      const [poll] = (await database.sql`
        INSERT INTO core.polls (topic_id, results_visible_before_voting, closes_at)
        VALUES (${topicId}, true, now() + interval '1 day')
        RETURNING id
      `) as Array<{ id: string }>;

      if (poll === undefined) {
        throw new Error("Could not create the poll");
      }

      const [question] = (await database.sql`
        INSERT INTO core.poll_questions (poll_id, position, prompt)
        VALUES (${poll.id}, 0, 'Which one?')
        RETURNING id
      `) as Array<{ id: string }>;

      if (question === undefined) {
        throw new Error("Could not create the poll question");
      }

      const [choice] = (await database.sql`
        INSERT INTO core.poll_choices (poll_id, question_id, position, label)
        VALUES (${poll.id}, ${question.id}, 0, 'First')
        RETURNING id
      `) as Array<{ id: string }>;

      if (choice === undefined) {
        throw new Error("Could not create the poll choice");
      }

      await database.sql`
        INSERT INTO core.poll_votes (poll_id, member_id)
        VALUES (${poll.id}, ${member})
      `;
      await database.sql`
        INSERT INTO core.poll_vote_choices (poll_id, member_id, question_id, choice_id)
        VALUES (${poll.id}, ${member}, ${question.id}, ${choice.id})
      `;
      await database.sql`
        INSERT INTO core.topic_reads (member_id, topic_id, last_read_post_id)
        VALUES (${member}, ${topicId}, ${postId})
      `;
      await database.sql`
        INSERT INTO core.forum_reads (member_id, forum_id) VALUES (${member}, ${forum.id})
      `;
      await database.sql`
        INSERT INTO core.topic_view_buffer (topic_id, viewer_key, bucket)
        VALUES (${topicId}, 'guest:abc', date_trunc('hour', now()))
      `;

      expect(await countRows(database, "core.post_revisions")).toBe(1);
      expect(await countRows(database, "core.poll_questions")).toBe(1);
      expect(await countRows(database, "core.poll_choices")).toBe(1);
      expect(await countRows(database, "core.poll_votes")).toBe(1);
      expect(await countRows(database, "core.poll_vote_choices")).toBe(1);
      expect(await countRows(database, "core.topic_reads")).toBe(1);
      expect(await countRows(database, "core.forum_reads")).toBe(1);
      expect(await countRows(database, "core.topic_view_buffer")).toBe(1);

      // A topic rename records the old slug for the permanent redirect (ADR 0001).
      await database.sql`
        UPDATE core.topics SET slug = 'welcome-to-bulletin' WHERE id = ${topicId}
      `;
      const [history] = (await database.sql`
        SELECT kind, resource_id::text AS resource_id, slug
        FROM core.slug_history WHERE kind = 'topic' AND resource_id = ${topicId}
      `) as Array<{ kind: string; resource_id: string; slug: string }>;
      expect(history).toEqual({
        kind: "topic",
        resource_id: topicId,
        slug: "welcome-to-the-board",
      });

      // Deleting the topic removes the whole content tree.
      await database.sql`DELETE FROM core.topics WHERE id = ${topicId}`;

      expect(await countRows(database, "core.topics")).toBe(0);
      expect(await countRows(database, "core.posts")).toBe(0);
      expect(await countRows(database, "core.post_revisions")).toBe(0);
      expect(await countRows(database, "core.polls")).toBe(0);
      expect(await countRows(database, "core.poll_questions")).toBe(0);
      expect(await countRows(database, "core.poll_choices")).toBe(0);
      expect(await countRows(database, "core.poll_votes")).toBe(0);
      expect(await countRows(database, "core.poll_vote_choices")).toBe(0);
      // Read-path buffers and markers are intentionally not tied to the topic row: a cached
      // page or a delete racing the flush must not fail the visit.
      expect(await countRows(database, "core.topic_reads")).toBe(1);
      expect(await countRows(database, "core.topic_view_buffer")).toBe(1);
      // Forum read markers are not topic content.
      expect(await countRows(database, "core.forum_reads")).toBe(1);
    });
  });

  test("enforces stable positions, one vote per member and the 30-minute view bucket", async () => {
    await withDb("topic_constraints", async (database) => {
      const forum = await createForum(database);
      const member = await createMember(database, "Constraint Member");
      const { topicId, postId } = await createTopic(database, forum.id, member);

      await expectRejection(database.sql`
        INSERT INTO core.posts (
          topic_id, author_id, body_md, body_html, body_text, render_version,
          sanitiser_version, position
        )
        VALUES (${topicId}, ${member}, 'Duplicate', '<p>Duplicate</p>', 'Duplicate', 1, 1, 1)
      `);

      const [poll] = (await database.sql`
        INSERT INTO core.polls (topic_id) VALUES (${topicId}) RETURNING id
      `) as Array<{ id: string }>;

      if (poll === undefined) {
        throw new Error("Could not create the poll");
      }

      await database.sql`
        INSERT INTO core.poll_votes (poll_id, member_id) VALUES (${poll.id}, ${member})
      `;
      await expectRejection(database.sql`
        INSERT INTO core.poll_votes (poll_id, member_id) VALUES (${poll.id}, ${member})
      `);

      const bucket = "2026-01-01T10:00:00Z";
      await database.sql`
        INSERT INTO core.topic_view_buffer (topic_id, viewer_key, bucket)
        VALUES (${topicId}, 'guest:one', ${bucket})
      `;
      await expectRejection(database.sql`
        INSERT INTO core.topic_view_buffer (topic_id, viewer_key, bucket)
        VALUES (${topicId}, 'guest:one', ${bucket})
      `);

      // The session's last-read post may be deleted without erasing the marker row.
      await database.sql`
        INSERT INTO core.post_revisions (
          post_id, body_md, body_html, body_text, render_version, sanitiser_version,
          editor_id, edited_at
        )
        VALUES (${postId}, 'Old', '<p>Old</p>', 'Old', 1, 1, ${member}, now())
      `;
      await database.sql`DELETE FROM core.posts WHERE id = ${postId}`;
      expect(await countRows(database, "core.post_revisions")).toBe(0);
    });
  }, 20_000);
});
