import { describe, expect, test } from "bun:test";
import { runBaseSeed } from "@bulletin/db/seed";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "topic_seed" }, run);
}

integrationDescribe("topic seed", () => {
  test("seeds a large multilingual dataset with every content shape", async () => {
    await withDb(async (database) => {
      const started = Date.now();
      await runBaseSeed({ databaseUrl: database.url });
      expect(Date.now() - started).toBeLessThan(180_000);

      const [counts] = (await database.sql`
        SELECT
          (SELECT count(*)::int FROM core.topics) AS topics,
          (SELECT count(*)::int FROM core.posts) AS posts,
          (SELECT count(DISTINCT forum_id)::int FROM core.topics) AS forums,
          (SELECT count(*)::int FROM core.post_revisions) AS revisions,
          (SELECT count(*)::int FROM core.posts WHERE visibility = 'soft_deleted') AS deleted_posts,
          (SELECT count(*)::int FROM core.topics WHERE pinned) AS pinned,
          (SELECT count(*)::int FROM core.topics WHERE locked) AS locked,
          (SELECT count(*)::int FROM core.topics WHERE moved_to IS NOT NULL) AS stubs,
          (SELECT count(*)::int FROM core.quote_snapshots) AS snapshots,
          (SELECT count(*)::int FROM core.poll_votes) AS poll_votes,
          (SELECT count(*)::int FROM core.polls) AS polls,
          (SELECT count(*)::int FROM core.topic_reads) AS read_markers
      `) as Array<{
        topics: number;
        posts: number;
        forums: number;
        revisions: number;
        deleted_posts: number;
        pinned: number;
        locked: number;
        stubs: number;
        snapshots: number;
        poll_votes: number;
        polls: number;
        read_markers: number;
      }>;

      expect(counts?.topics).toBeGreaterThanOrEqual(1_000);
      expect(counts?.posts).toBeGreaterThanOrEqual(4_000);
      expect(counts?.forums).toBeGreaterThanOrEqual(10);
      expect(counts?.revisions).toBeGreaterThan(0);
      expect(counts?.deleted_posts).toBeGreaterThan(0);
      expect(counts?.pinned).toBeGreaterThan(0);
      expect(counts?.locked).toBeGreaterThan(0);
      expect(counts?.stubs).toBeGreaterThan(0);
      expect(counts?.snapshots).toBeGreaterThan(0);
      expect(counts?.polls).toBeGreaterThan(0);
      expect(counts?.poll_votes).toBeGreaterThan(0);
      expect(counts?.read_markers).toBeGreaterThan(0);

      const shapes = (await database.sql`
        SELECT
          count(*) FILTER (WHERE body_html LIKE '%<bl-quote%')::int AS quotes,
          count(*) FILTER (WHERE body_html LIKE '%/profile/%')::int AS mentions,
          count(*) FILTER (WHERE body_html LIKE '%<pre><code%')::int AS code,
          count(*) FILTER (WHERE body_html LIKE '%youtube-nocookie%')::int AS embeds,
          count(*) FILTER (WHERE edited_at IS NOT NULL)::int AS edited
        FROM core.posts
      `) as Array<{
        quotes: number;
        mentions: number;
        code: number;
        embeds: number;
        edited: number;
      }>;

      expect(shapes[0]?.quotes).toBeGreaterThan(0);
      expect(shapes[0]?.mentions).toBeGreaterThan(0);
      expect(shapes[0]?.code).toBeGreaterThan(0);
      expect(shapes[0]?.embeds).toBeGreaterThan(0);
      expect(shapes[0]?.edited).toBeGreaterThan(0);

      const [localised] = (await database.sql`
        SELECT count(*)::int AS count
        FROM core.topics t
        JOIN core.members m ON m.id = t.starter_id
        WHERE m.locale IN ('es', 'fr')
      `) as Array<{ count: number }>;
      expect(localised?.count).toBeGreaterThan(0);

      const [counters] = (await database.sql`
        SELECT
          (SELECT coalesce(sum(topic_count), 0)::int FROM core.forums) AS topic_sum,
          (SELECT count(*)::int FROM core.topics
            WHERE moved_to IS NULL AND visibility = 'visible') AS real_topics,
          (SELECT coalesce(sum(post_count), 0)::int FROM core.forums) AS post_sum,
          (SELECT count(*)::int FROM core.posts WHERE visibility = 'visible') AS visible_posts,
          (
            SELECT count(*)::int FROM core.topics t
            WHERE t.moved_to IS NULL
              AND t.last_post_id IS NOT NULL
              AND t.first_post_id IS NULL
          ) AS broken_topics
      `) as Array<{
        topic_sum: number;
        real_topics: number;
        post_sum: number;
        visible_posts: number;
        broken_topics: number;
      }>;

      expect(counters?.topic_sum).toBe(counters?.real_topics);
      expect(counters?.post_sum).toBe(counters?.visible_posts);
      expect(counters?.broken_topics).toBe(0);
    });
  }, 240_000);
});
