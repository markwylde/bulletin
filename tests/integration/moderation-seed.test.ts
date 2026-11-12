import { describe, expect, test } from "bun:test";
import { runBaseSeed } from "@bulletin/db/seed";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "moderation_seed" }, run);
}

integrationDescribe("moderation seed", () => {
  test("seeds held content, reports, warnings, bans, filters, actions and log entries", async () => {
    await withDb(async (database) => {
      const first = await runBaseSeed({ databaseUrl: database.url });
      const second = await runBaseSeed({ databaseUrl: database.url });
      expect(first.ran).toBe(true);
      expect(second.ran).toBe(false);

      const [held] = (await database.sql`
        SELECT t.visibility AS topic_visibility, t.hold_reason AS topic_reason,
          p.visibility AS post_visibility, p.hold_reason AS post_reason,
          p.body_md, p.body_html, m.display_name AS author
        FROM core.topics t
        JOIN core.posts p ON p.topic_id = t.id
        JOIN core.members m ON m.id = p.author_id
        WHERE t.visibility = 'unapproved'
        ORDER BY t.id DESC LIMIT 1
      `) as Array<{
        topic_visibility: string;
        topic_reason: string | null;
        post_visibility: string;
        post_reason: string | null;
        body_md: string;
        body_html: string;
        author: string;
      }>;
      expect(held).toMatchObject({
        topic_visibility: "unapproved",
        topic_reason: "new_member",
        post_visibility: "unapproved",
        post_reason: "new_member",
        author: "New Member",
      });
      expect(held?.body_md).toContain("damn");
      expect(held?.body_html).toContain("****");
      expect(held?.body_html).not.toContain("damn");

      const reports = (await database.sql`
        SELECT target_type, status FROM core.reports
        ORDER BY target_type, status
      `) as Array<{ target_type: string; status: string }>;
      expect(reports).toEqual(
        expect.arrayContaining([
          { target_type: "member", status: "resolved" },
          { target_type: "pm", status: "open" },
          { target_type: "post", status: "open" },
        ]),
      );
      const [pmAccess] = (await database.sql`
        SELECT count(*)::int AS count FROM core.report_pm_access
      `) as Array<{ count: number }>;
      expect(pmAccess?.count).toBe(2);
      const [holds] = (await database.sql`
        SELECT count(*)::int AS count FROM core.conversation_message_holds WHERE holder = 'report'
      `) as Array<{ count: number }>;
      expect(holds?.count).toBe(2);

      const warnings = (await database.sql`
        SELECT points, ack_required FROM core.warnings
      `) as Array<{ points: number; ack_required: boolean }>;
      expect(warnings).toEqual([{ points: 5, ack_required: true }]);
      const restrictions = (await database.sql`
        SELECT kind FROM core.member_restrictions ORDER BY kind
      `) as Array<{ kind: string }>;
      expect(restrictions.map((row) => row.kind)).toEqual([
        "cannot_post",
        "posts_require_approval",
      ]);
      const [thresholds] = (await database.sql`
        SELECT count(*)::int AS count FROM core.warning_thresholds
      `) as Array<{ count: number }>;
      expect(thresholds?.count).toBe(3);

      const [memberBan] = (await database.sql`
        SELECT count(*)::int AS count FROM core.member_bans
      `) as Array<{ count: number }>;
      expect(memberBan?.count).toBe(1);
      const [ipBan] = (await database.sql`
        SELECT count(*)::int AS count FROM core.ip_bans
      `) as Array<{ count: number }>;
      expect(ipBan?.count).toBe(1);

      const filters = (await database.sql`
        SELECT word, mode FROM core.filter_words ORDER BY word
      `) as Array<{ word: string; mode: string }>;
      expect(filters.map((row) => `${row.word}:${row.mode}`)).toEqual([
        "badword:block",
        "crap:replace",
        "damn:replace",
      ]);
      const [domain] = (await database.sql`
        SELECT domain FROM core.filter_domains
      `) as Array<{ domain: string }>;
      expect(domain?.domain).toBe("spam.example");
      const [filterSettings] = (await database.sql`
        SELECT version::text AS version FROM core.filter_settings WHERE id = 1
      `) as Array<{ version: string }>;
      expect(Number(filterSettings?.version)).toBeGreaterThan(0);

      const [multimod] = (await database.sql`
        SELECT name, forum_ids::text[] AS forums, steps FROM core.multimod_actions
        WHERE name = 'Mark solved'
      `) as Array<{ name: string; forums: string[]; steps: unknown[] }>;
      expect(multimod?.name).toBe("Mark solved");
      expect(Array.isArray(multimod?.steps)).toBe(true);

      const log = (await database.sql`
        SELECT action FROM core.moderation_log ORDER BY id
      `) as Array<{ action: string }>;
      expect(log.map((row) => row.action)).toEqual(
        expect.arrayContaining([
          "topic.pin",
          "topic.merge",
          "warning.issue",
          "member.ban",
          "ip.ban",
          "report.status",
        ]),
      );
    });
  }, 60_000);
});
