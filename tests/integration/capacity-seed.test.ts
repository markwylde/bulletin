import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  CAPACITY_PROFILES,
  CAPACITY_WRITER_SUBS,
  type CapacityProfile,
  capacityPlan,
  capacitySeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  seedCapacity,
  topicsSeedModule,
} from "@bulletin/db/seed";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

describe("capacity profile (ADR 0020)", () => {
  test("SEED_SIZE=large targets 1M posts", () => {
    expect(CAPACITY_PROFILES.large?.posts).toBe(1_000_000);
    expect(CAPACITY_PROFILES.default).toBeUndefined();
    expect(CAPACITY_PROFILES.small).toBeUndefined();
  });

  test("plans topics for the posts still missing", () => {
    const profile: CapacityProfile = { posts: 1_000_000, members: 5_000, postsPerTopic: 20 };

    expect(capacityPlan(profile, 4_321)).toEqual({ posts: 995_679, topics: 49_784 });
    expect(capacityPlan(profile, 1_000_000)).toEqual({ posts: 0, topics: 0 });
    expect(capacitySeedModule.dependsOn).toContain("topics");
  });
});

/** A digest of every row the capacity seed wrote, ids included. */
async function capacityDigest(database: TestDatabase): Promise<string> {
  const [row] = (await database.sql`
    SELECT md5(
      (SELECT string_agg(concat_ws('|', id, display_name, name_skeleton, joined_at, post_count),
                         ',' ORDER BY id)
         FROM core.members WHERE display_name LIKE 'Capacity member %')
      || (SELECT string_agg(concat_ws('|', id, forum_id, title, slug, starter_id, created_at,
                                      reply_count, first_post_id, last_post_id, last_post_at),
                            ',' ORDER BY id)
            FROM core.topics WHERE slug LIKE 'capacity-topic-%')
      || (SELECT string_agg(concat_ws('|', p.id, p.topic_id, p.author_id, p.position,
                                      md5(p.body_html), p.created_at), ',' ORDER BY p.id)
            FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
           WHERE t.slug LIKE 'capacity-topic-%')
    ) AS digest
  `) as Array<{ digest: string }>;

  return row?.digest ?? "";
}

integrationDescribe("capacity seed", () => {
  test("seeds the profile deterministically and keeps counters consistent", async () => {
    if (adminUrl === undefined) {
      return;
    }

    const digests: string[] = [];

    for (const run of [1, 2]) {
      await withTestDatabase({ adminUrl, prefix: `capacity_${run}` }, async (database) => {
        await runSeeds({
          sql: database.sql,
          registry: new SeedRegistry([
            baseSeedModule,
            permissionFixtureSeedModule,
            groupsSeedModule,
            forumExtrasSeedModule,
            membersSeedModule,
            topicsSeedModule,
          ]),
        });
        const [before] = (await database.sql`
          SELECT count(*)::int AS posts FROM core.posts
        `) as Array<{ posts: number }>;
        // A scaled-down profile with the same shape as `large` (1M posts take minutes).
        const profile: CapacityProfile = {
          posts: (before?.posts ?? 0) + 1_510,
          members: 40,
          postsPerTopic: 20,
        };

        expect(await seedCapacity(database.sql, profile)).toEqual({ posts: 1_510, topics: 76 });
        // A rerun on a seeded database adds nothing.
        expect(await seedCapacity(database.sql, profile)).toEqual({ posts: 0, topics: 0 });

        const [counts] = (await database.sql`
          SELECT
            (SELECT count(*)::int FROM core.posts) AS posts,
            (SELECT count(*)::int FROM core.topics WHERE slug LIKE 'capacity-topic-%') AS topics,
            (SELECT count(*)::int FROM core.topics t
              WHERE t.slug LIKE 'capacity-topic-%'
                AND t.reply_count + 1 <> (SELECT count(*) FROM core.posts p WHERE p.topic_id = t.id))
              AS bad_counters,
            (SELECT count(*)::int FROM core.member_groups mg
               JOIN core.members m ON m.id = mg.member_id
              WHERE m.display_name LIKE 'Capacity member %' AND mg.is_primary) AS primaries,
            (SELECT count(*)::int FROM core.forums f
              WHERE f.post_count <> (SELECT count(*) FROM core.posts p
                                     JOIN core.topics t ON t.id = p.topic_id
                                     WHERE t.forum_id = f.id AND p.visibility = 'visible'))
              AS bad_forums
        `) as Array<{
          posts: number;
          topics: number;
          bad_counters: number;
          primaries: number;
          bad_forums: number;
        }>;

        expect(counts).toEqual({
          posts: profile.posts,
          topics: 76,
          bad_counters: 0,
          primaries: 40,
          bad_forums: 0,
        });

        // The load-test writers post without the flood interval (min merge over groups).
        const writers = (await database.sql`
          SELECT count(*)::int AS members, min(s.value::text) AS flood
          FROM core.member_groups mg
          JOIN core.groups g ON g.id = mg.group_id AND g.key = 'load_writers'
          JOIN core.group_settings s
            ON s.group_id = g.id AND s.key = 'posting.flood_control_seconds'
        `) as Array<{ members: number; flood: string }>;
        expect(writers[0]).toEqual({ members: CAPACITY_WRITER_SUBS.length, flood: "0" });

        digests.push(await capacityDigest(database));
      });
    }

    expect(digests[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(digests[1]).toBe(digests[0] ?? "");
  }, 120_000);
});
