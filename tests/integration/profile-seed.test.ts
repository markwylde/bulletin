import { describe, expect, test } from "bun:test";
import { runBaseSeed } from "@bulletin/db/seed";
import { loadMemberCards } from "@bulletin/domain/topics";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "profile_seed" }, async (database) => {
    await runBaseSeed({ databaseUrl: database.url });
    await run(database);
  });
}

integrationDescribe("profile seed", () => {
  test("seeds custom fields, about, signatures, titles, ranks and badges", async () => {
    await withSeededDb(async (database) => {
      const fields = (await database.sql`
        SELECT labels->>'en' AS label, type
        FROM core.profile_fields
        ORDER BY position
      `) as Array<{ label: string; type: string }>;
      expect(fields).toEqual([
        { label: "Location", type: "short_text" },
        { label: "Pronouns", type: "select" },
        { label: "Moderator note", type: "short_text" },
      ]);

      const [moderatorField] = (await database.sql`
        SELECT id::text AS id FROM core.profile_fields WHERE labels->>'en' = 'Moderator note'
      `) as Array<{ id: string }>;
      const staffVisibleGroups = (await database.sql`
        SELECT g.key
        FROM core.profile_field_groups r
        JOIN core.groups g ON g.id = r.group_id
        WHERE r.field_id = ${moderatorField?.id ?? "0"} AND r.can_view
        ORDER BY g.key
      `) as Array<{ key: string }>;
      expect(staffVisibleGroups.map((row) => row.key)).toEqual([
        "administrators",
        "moderators",
        "super_moderators",
      ]);

      const member = (await database.sql`
        SELECT
          about_html, signature_html, custom_title,
          (SELECT value FROM core.member_field_values v
             JOIN core.profile_fields f ON f.id = v.field_id
             WHERE v.member_id = m.id AND f.labels->>'en' = 'Location') AS location,
          (SELECT value FROM core.member_field_values v
             JOIN core.profile_fields f ON f.id = v.field_id
             WHERE v.member_id = m.id AND f.labels->>'en' = 'Moderator note') AS staff_note
        FROM core.members m
        WHERE m.display_name = 'Regular Member One'
      `) as Array<{
        about_html: string;
        signature_html: string;
        custom_title: string | null;
        location: string;
        staff_note: string | null;
      }>;
      expect(member[0]?.about_html).toContain("small things on the web");
      expect(member[0]?.signature_html).toContain("<em>Be kind.</em>");
      expect(member[0]?.custom_title).toBe("Night Owl");
      expect(member[0]?.location).toBe("The Netherlands");
      expect(member[0]?.staff_note).toBe("Seeded staff-only note");

      const ranks = (await database.sql`
        SELECT min_posts, pips FROM core.ranks ORDER BY min_posts
      `) as Array<{ min_posts: number; pips: number }>;
      expect(ranks).toHaveLength(5);
      expect(ranks[0]).toEqual({ min_posts: 0, pips: 1 });

      const cards = await loadMemberCards(
        database.sql,
        [
          (
            (await database.sql`
              SELECT id::text AS id FROM core.members WHERE display_name = 'Regular Member One'
            `) as Array<{ id: string }>
          )[0]?.id ?? "0",
        ],
        "en",
      );
      const card = [...cards.values()][0];
      expect(card?.customTitle).toBe("Night Owl");
      expect(card?.rankTitle).toBeTruthy();
      expect(card?.featuredBadges.length).toBeGreaterThanOrEqual(2);

      const badges = (await database.sql`
        SELECT b.key, r.type, r.threshold
        FROM core.badges b
        LEFT JOIN core.badge_rules r ON r.badge_id = b.id
        ORDER BY b.position
      `) as Array<{ key: string; type: string | null; threshold: number | null }>;
      expect(badges.map((badge) => badge.key)).toEqual(["helpful", "chatter", "loved"]);
      expect(badges.find((badge) => badge.key === "chatter")).toMatchObject({
        type: "post_count",
        threshold: 50,
      });

      const [awards] = (await database.sql`
        SELECT count(*)::int AS count FROM core.member_badges WHERE revoked_at IS NULL
      `) as Array<{ count: number }>;
      expect(awards?.count ?? 0).toBeGreaterThanOrEqual(5);

      const [featured] = (await database.sql`
        SELECT count(*)::int AS count FROM core.member_badges WHERE featured
      `) as Array<{ count: number }>;
      expect(featured?.count ?? 0).toBeGreaterThanOrEqual(2);
    });
  }, 30_000);

  test("seeds ignores, friendships, presence and leaderboard entries", async () => {
    await withSeededDb(async (database) => {
      const [ignore] = (await database.sql`
        SELECT count(*)::int AS count FROM core.member_ignores
      `) as Array<{ count: number }>;
      expect(ignore?.count).toBeGreaterThanOrEqual(1);

      const friendships = (await database.sql`
        SELECT count(*)::int AS count FROM core.friendships WHERE state = 'accepted'
      `) as Array<{ count: number }>;
      expect(friendships[0]?.count ?? 0).toBeGreaterThanOrEqual(2);

      const [presence] = (await database.sql`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE viewer_key LIKE 'guest:%')::int AS guests
        FROM core.presence
      `) as Array<{ total: number; guests: number }>;
      expect(presence?.total ?? 0).toBeGreaterThanOrEqual(6);
      expect(presence?.guests ?? 0).toBe(2);

      const leaderboard = (await database.sql`
        SELECT period, metric, count(*)::int AS rows
        FROM core.leaderboard_entries
        GROUP BY period, metric
        ORDER BY period, metric
      `) as Array<{ period: string; metric: string; rows: number }>;
      expect(leaderboard).toHaveLength(8);
      expect(leaderboard.every((row) => row.rows > 0)).toBe(true);
    });
  }, 30_000);
});
