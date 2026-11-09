import { describe, expect, test } from "bun:test";
import {
  adminLogSeedModule,
  baseSeedModule,
  membersSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { withTestDatabase } from "@bulletin/test-utils/database";

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
        registry: new SeedRegistry([baseSeedModule, membersSeedModule, adminLogSeedModule]),
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
