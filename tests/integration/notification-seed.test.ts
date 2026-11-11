import { describe, expect, test } from "bun:test";
import { runBaseSeed } from "@bulletin/db/seed";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "notification_seed" }, run);
}

integrationDescribe("notification seed", () => {
  test("seeds follows, notifications, digests and a preference once", async () => {
    await withDb(async (database) => {
      const first = await runBaseSeed({ databaseUrl: database.url });
      expect(first.ran).toBe(true);
      expect(first.modules).toContain("notifications");

      const second = await runBaseSeed({ databaseUrl: database.url });
      expect(second).toEqual({ ran: false, modules: [] });

      const [members] = (await database.sql`
        SELECT
          (SELECT count(*)::int FROM core.followed_topics) AS topics,
          (SELECT count(*)::int FROM core.followed_forums) AS forums,
          (SELECT count(*)::int FROM core.followed_members) AS members,
          (SELECT count(*)::int FROM core.digest_subscriptions) AS digests,
          (SELECT count(*)::int FROM core.notification_preferences) AS preferences,
          (SELECT count(*)::int FROM core.notifications) AS notifications
      `) as Array<Record<string, number>>;

      expect(members).toEqual({
        topics: 3,
        forums: 2,
        members: 3,
        digests: 3,
        preferences: 1,
        notifications: 6,
      });

      const [spanish] = (await database.sql`
        SELECT n.type, n.count, n.read_at, n.actor_id::text AS actor_id
        FROM core.notifications n
        JOIN core.members m ON m.id = n.member_id
        JOIN pii.identities i ON i.member_id = m.id
        WHERE i.sub = 'member-es'
      `) as Array<{ type: string; count: number; read_at: Date | null; actor_id: string }>;

      expect(spanish).toMatchObject({ type: "topic.reply", count: 2, read_at: null });

      const frequencies = (await database.sql`
        SELECT i.sub, d.frequency
        FROM core.digest_subscriptions d
        JOIN pii.identities i ON i.member_id = d.member_id
        ORDER BY i.sub
      `) as Array<{ sub: string; frequency: string }>;

      expect(frequencies).toEqual([
        { sub: "member-1", frequency: "weekly" },
        { sub: "member-2", frequency: "daily" },
        { sub: "member-fr", frequency: "weekly" },
      ]);

      const [preference] = (await database.sql`
        SELECT p.enabled
        FROM core.notification_preferences p
        JOIN pii.identities i ON i.member_id = p.member_id
        WHERE i.sub = 'member-1' AND p.type = 'post.mention' AND p.channel = 'email'
      `) as Array<{ enabled: boolean }>;

      expect(preference?.enabled).toBe(false);
    });
  }, 120_000);
});
