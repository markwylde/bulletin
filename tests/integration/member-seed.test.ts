import { describe, expect, test } from "bun:test";
import { baseSeedModule, membersSeedModule, runSeeds, SeedRegistry } from "@bulletin/db/seed";
import { withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

integrationDescribe("member seed", () => {
  test("seeds one Spanish and one French member", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "member_seed" }, async ({ sql }) => {
      await runSeeds({
        sql,
        registry: new SeedRegistry([baseSeedModule, membersSeedModule]),
      });

      const members = (await sql`
        SELECT display_name, name_skeleton, locale
        FROM core.members
        ORDER BY display_name
      `) as Array<{ display_name: string; name_skeleton: string; locale: string | null }>;

      expect(members).toEqual([
        {
          display_name: "Membre Français",
          name_skeleton: "membre francais",
          locale: "fr",
        },
        {
          display_name: "Miembro Español",
          name_skeleton: "miembro espanol",
          locale: "es",
        },
      ]);

      const groups = (await sql`
        SELECT m.display_name, g.key, mg.is_primary
        FROM core.member_groups mg
        JOIN core.members m ON m.id = mg.member_id
        JOIN core.groups g ON g.id = mg.group_id
        ORDER BY m.display_name
      `) as Array<{ display_name: string; key: string; is_primary: boolean }>;

      expect(groups).toEqual([
        { display_name: "Membre Français", key: "members", is_primary: true },
        { display_name: "Miembro Español", key: "members", is_primary: true },
      ]);
    });
  }, 15_000);
});
