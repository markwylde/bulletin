import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import { bumpFlagTag } from "@bulletin/db/flags";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { CODE_FLAG_DEFINITIONS, searchFlag } from "@bulletin/flags";
import { createServerT } from "@bulletin/i18n";
import { assertCacheVariants } from "@bulletin/test-utils/cache-variants";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderHomeRoute } from "../../apps/user-app/src/home/route.ts";
import { renderProfileRoute } from "../../apps/user-app/src/profiles/route.ts";
import { renderSearchRoute } from "../../apps/user-app/src/search/route.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "search_flag" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
}

async function setSearchFlag(database: TestDatabase, enabled: boolean): Promise<void> {
  await database.sql`
    UPDATE core.feature_flags
    SET default_value = ${enabled}, updated_at = now()
    WHERE key = 'search'
  `;
  await bumpFlagTag(database.sql);
}

async function memberSession(database: TestDatabase, sub: string): Promise<UserAppSessionContext> {
  const [row] = (await database.sql`
    SELECT i.member_id::text AS member_id, m.display_name
    FROM pii.identities i
    JOIN core.members m ON m.id = i.member_id
    WHERE i.sub = ${sub}
  `) as Array<{ member_id: string; display_name: string | null }>;

  if (row === undefined) {
    throw new Error(`No seeded member ${sub}`);
  }

  return {
    memberId: row.member_id,
    sessionId: "0",
    reauthAt: new Date().toISOString(),
    locale: "en",
    displayName: row.display_name,
  };
}

integrationDescribe("search feature flag", () => {
  test("is declared off in code and turned on by the seed", async () => {
    expect(searchFlag).toMatchObject({
      key: "search",
      defaultValue: false,
      affectsRender: true,
    });
    expect(CODE_FLAG_DEFINITIONS).toContain(searchFlag);

    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "search_flag_seed" }, async ({ sql }) => {
      await runSeeds({
        sql,
        registry: new SeedRegistry([baseSeedModule, flagsSeedModule]),
      });
      const [row] = (await sql`
        SELECT default_value, affects_render
        FROM core.feature_flags
        WHERE key = 'search'
      `) as Array<{ default_value: boolean; affects_render: boolean }>;

      expect(row).toEqual({ default_value: true, affects_render: true });
    });
  });

  test("all three routes answer 404 while the flag is off", async () => {
    await withSeededDb(async (database) => {
      const session = await memberSession(database, "member-1");
      await setSearchFlag(database, false);

      for (const mode of ["search", "member", "new"] as const) {
        const result = await renderSearchRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: mode === "search" ? null : session,
          params: new URLSearchParams(),
          mode,
          ...(mode === "member" ? { ref: `${session.memberId}-regular-member-one` } : {}),
        });

        expect(result.kind).toBe("page");

        if (result.kind === "page") {
          expect(result.status).toBe(404);
          expect(result.html).not.toContain("data-search-page");
          expect(result.html).toContain("data-theme-error");
        }
      }

      await setSearchFlag(database, true);
      const enabled = await renderSearchRoute({
        sql: database.sql,
        locale: "en",
        translate,
        session: null,
        params: new URLSearchParams("q=board"),
        mode: "search",
      });

      expect(enabled.kind).toBe("page");

      if (enabled.kind === "page") {
        expect(enabled.status).toBe(200);
        expect(enabled.html).toContain("data-search-page");
      }
    });
  });

  test("member search results are available through the gated route", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const admin = await memberSession(database, "admin");
      const [adminGroup] = (await database.sql`
        SELECT id FROM core.groups WHERE key = 'administrators'
      `) as Array<{ id: string }>;

      if (adminGroup === undefined) {
        throw new Error("Missing administrators group");
      }

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        VALUES (${adminGroup.id}, 'members.view_hidden', 'true'::jsonb)
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;
      await database.sql`
        INSERT INTO core.members (display_name, locale)
        VALUES ('John', 'en'), ('Jhon', 'en')
      `;
      await database.sql`UPDATE core.members SET hide_from_member_list = true WHERE display_name = 'Jhon'`;

      const render = (session: UserAppSessionContext) =>
        renderSearchRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session,
          params: new URLSearchParams("q=jhon&kind=members"),
          mode: "search",
        });

      const visible = await render(member);
      expect(visible.kind).toBe("page");

      if (visible.kind === "page") {
        expect(visible.html).toContain("John");
        expect(visible.html).not.toContain("Jhon");
        expect(visible.html).toContain("data-search-member");
      }

      const withHidden = await render(admin);
      expect(withHidden.kind).toBe("page");

      if (withHidden.kind === "page") {
        expect(withHidden.html).toContain("Jhon");
      }
    });
  });

  test("the cached shell varies with the search flag and never leaks the quick search", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const render = () =>
          renderHomeRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: null,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });

        const report = await assertCacheVariants({
          route: "/",
          cache,
          cases: [
            {
              name: "off",
              setup: () => setSearchFlag(database, false),
              async render() {
                const result = await render();

                return {
                  variant: result.variant,
                  html: result.html,
                  ...(result.cache === null ? {} : { cache: result.cache }),
                };
              },
            },
            {
              name: "on",
              setup: () => setSearchFlag(database, true),
              async render() {
                const result = await render();

                return {
                  variant: result.variant,
                  html: result.html,
                  ...(result.cache === null ? {} : { cache: result.cache }),
                };
              },
            },
          ],
          leaks: [
            {
              markers: ["data-quick-search-input", "data-new-content-link"],
              absentFrom: ["off"],
            },
          ],
        });

        expect(report.variants.get("off")).not.toBe(report.variants.get("on"));
      } finally {
        await versions.close();
      }
    });
  });

  test("the profile content link follows the flag", async () => {
    await withSeededDb(async (database) => {
      const session = await memberSession(database, "member-1");
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const render = () =>
          renderProfileRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session,
            ref: `${session.memberId}-regular-member-one`,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });

        await setSearchFlag(database, false);
        const off = await render();
        await setSearchFlag(database, true);
        const on = await render();

        expect(off.kind).toBe("page");
        expect(on.kind).toBe("page");

        if (off.kind === "page" && on.kind === "page") {
          expect(off.html).not.toContain("data-profile-content-link");
          expect(on.html).toContain("data-profile-content-link");
        }
      } finally {
        await versions.close();
      }
    });
  });
});
