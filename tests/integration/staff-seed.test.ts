import { describe, expect, test } from "bun:test";
import { readFlagVersion } from "@bulletin/db/flags";
import {
  adminLogSeedModule,
  baseSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { withTestDatabase } from "@bulletin/test-utils/database";
import { listFlags } from "../../apps/staff-api/src/flags.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

integrationDescribe("staff console seed", () => {
  test("seeds board settings and recent admin log entries", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "staff_seed" }, async ({ sql }) => {
      const result = await runSeeds({
        sql,
        registry: new SeedRegistry([
          baseSeedModule,
          permissionFixtureSeedModule,
          groupsSeedModule,
          membersSeedModule,
          adminLogSeedModule,
        ]),
      });

      expect(result.ran).toBe(true);

      const [board] = (await sql`
        SELECT board_name, board_description, default_locale, offline, offline_message
        FROM core.board_settings
        WHERE id = 1
      `) as Array<{
        board_name: string;
        board_description: string;
        default_locale: string;
        offline: boolean;
        offline_message: string;
      }>;

      expect(board).toMatchObject({
        board_name: "Bulletin",
        default_locale: "en",
        offline: false,
        offline_message: "",
      });
      expect(board?.board_description.length).toBeGreaterThan(10);

      const log = (await sql`
        SELECT a.action, m.display_name AS actor, a.target_type, a.summary
        FROM core.admin_log a
        LEFT JOIN core.members m ON m.id = a.actor_member_id
        ORDER BY a.created_at DESC
      `) as Array<{
        action: string;
        actor: string | null;
        target_type: string | null;
        summary: unknown;
      }>;

      expect(log).toHaveLength(3);
      expect(log.map((entry) => entry.action)).toEqual([
        "i18n.override.revert",
        "i18n.override.update",
        "board.settings.update",
      ]);
      expect(log[2]).toMatchObject({
        actor: "Admin",
        target_type: "board",
      });
      expect(log[2]?.summary).toMatchObject({
        before: { boardName: "Bulletin Forum" },
        after: { boardName: "Bulletin" },
      });
    });
  }, 30_000);
});

integrationDescribe("flags seed", () => {
  test("seeds a group-targeted, a 50% rollout and a render-affecting flag", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "flags_seed" }, async ({ sql }) => {
      const registry = new SeedRegistry([baseSeedModule, flagsSeedModule]);
      expect((await runSeeds({ sql, registry })).ran).toBe(true);
      expect(await readFlagVersion(sql)).toBe("1");

      const now = Date.now();
      const flags = await listFlags(sql, now);
      const byKey = new Map(flags.map((flag) => [flag.key, flag]));

      expect([...byKey.keys()]).toEqual([
        "announcements",
        "attachments",
        "avatar_upload",
        "badges",
        "compactTopicList",
        "conversations",
        "custom_profile_fields",
        "digests",
        "follows",
        "friends",
        "ignore_list",
        "leaderboards",
        "member_directory",
        "mentions",
        "multimod",
        "newEditor",
        "notifications",
        "plugins",
        "polls",
        "public_api",
        "quickReply",
        "reactions",
        "realtime",
        "reputation",
        "search",
        "signatures",
        "theme_chooser",
        "unfurls",
        "warnings",
        "webhooks",
        "whos_online",
      ]);

      expect(byKey.get("announcements")).toMatchObject({
        description: "Global and forum announcements.",
        owner: "core",
        defaultValue: true,
        affectsRender: true,
        clientVisible: true,
        rules: [],
      });
      expect(byKey.get("newEditor")).toMatchObject({
        description: "Markdown WYSIWYG editor for new posts.",
        owner: "content",
        defaultValue: false,
        affectsRender: false,
        rules: [{ type: "group", groups: ["super_moderators"], value: true }],
        stale: false,
      });
      expect(byKey.get("quickReply")).toMatchObject({
        defaultValue: false,
        affectsRender: false,
        rules: [{ type: "percentage", percent: 50, value: true }],
        stale: false,
      });
      expect(byKey.get("compactTopicList")).toMatchObject({
        defaultValue: true,
        affectsRender: true,
        clientVisible: false,
        rules: [],
        stale: true,
      });
      expect(byKey.get("compactTopicList")?.ageDays).toBeGreaterThanOrEqual(139);

      const tracked = (await sql`
        SELECT key, fully_on_since
        FROM core.feature_flags
        WHERE key IN ('compactTopicList', 'newEditor', 'quickReply')
        ORDER BY key
      `) as Array<{ key: string; fully_on_since: Date | string | null }>;
      expect(tracked.map((row) => row.key)).toEqual([
        "compactTopicList",
        "newEditor",
        "quickReply",
      ]);
      expect(tracked.map((row) => row.fully_on_since === null)).toEqual([false, true, true]);

      // A second start does not reseed, so staff edits survive (ADR 0002).
      await sql`
        UPDATE core.feature_flags
        SET rules = '[{"type": "percentage", "percent": 25, "value": true}]'::jsonb,
            updated_at = now()
        WHERE key = 'quickReply'
      `;
      expect((await runSeeds({ sql, registry })).ran).toBe(false);
      expect((await listFlags(sql, now)).find((flag) => flag.key === "quickReply")?.rules).toEqual([
        { type: "percentage", percent: 25, value: true },
      ]);
    });
  }, 30_000);
});
