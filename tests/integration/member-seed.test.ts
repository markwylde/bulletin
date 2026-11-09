import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  membersSeedModule,
  runSeeds,
  SEEDED_PROFILES,
  SeedRegistry,
} from "@bulletin/db/seed";
import { withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

integrationDescribe("member seed", () => {
  test("seeds every DarkAuth profile with its identity, groups and name history", async () => {
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

      expect(members).toHaveLength(SEEDED_PROFILES.length);
      for (const profile of SEEDED_PROFILES) {
        expect(members).toContainEqual({
          display_name: profile.name,
          name_skeleton: profile.skeleton,
          locale: profile.locale,
        });
      }

      const identities = (await sql`
        SELECT issuer, sub, email, idp_name
        FROM pii.identities
        ORDER BY sub
      `) as Array<{ issuer: string; sub: string; email: string; idp_name: string }>;

      expect(identities).toHaveLength(SEEDED_PROFILES.length);
      for (const profile of SEEDED_PROFILES) {
        expect(identities).toContainEqual({
          issuer: "http://auth.bulletin.localhost:8080",
          sub: profile.sub,
          email: profile.email,
          idp_name: profile.name,
        });
      }

      const groups = (await sql`
        SELECT i.sub, g.key, mg.is_primary
        FROM core.member_groups mg
        JOIN pii.identities i ON i.member_id = mg.member_id
        JOIN core.groups g ON g.id = mg.group_id
        ORDER BY i.sub, g.key
      `) as Array<{ sub: string; key: string; is_primary: boolean }>;

      for (const profile of SEEDED_PROFILES) {
        const expected =
          profile.group === "members"
            ? [{ sub: profile.sub, key: "members", is_primary: true }]
            : [
                { sub: profile.sub, key: profile.group, is_primary: true },
                { sub: profile.sub, key: "members", is_primary: false },
              ];
        const actual = groups
          .filter((group) => group.sub === profile.sub)
          .sort((left, right) => left.key.localeCompare(right.key));
        expect(actual).toEqual(expected.sort((left, right) => left.key.localeCompare(right.key)));
      }

      const history = (await sql`
        SELECT i.sub, h.old_name, h.new_name
        FROM core.member_name_history h
        JOIN pii.identities i ON i.member_id = h.member_id
      `) as Array<{ sub: string; old_name: string; new_name: string }>;

      expect(history).toEqual([
        {
          sub: "member-1",
          old_name: "Regular Member",
          new_name: "Regular Member One",
        },
      ]);
    });
  }, 15_000);
});
