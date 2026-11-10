import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SEEDED_PLUGIN_GENERATION,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import {
  CapabilityView,
  loadPermissionSnapshot,
  UndeclaredCapabilityError,
} from "@bulletin/domain/permissions";
import { FIXTURE_FORUM_TREE } from "@bulletin/domain/permissions/fixtures";
import { createServerT } from "@bulletin/i18n";
import {
  loadDefaultThemeTemplates,
  loadDemoHookFragments,
  loadHookFragments,
  loadTheme,
} from "@bulletin/templates";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { buildAccountPage } from "../../apps/user-app/src/account/page.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import {
  accountContract,
  callbackContract,
  DEMO_SHELL_ISLANDS,
  demoContract,
  homeContract,
  loginContract,
} from "../../apps/user-app/src/contracts.ts";
import { buildDemoPage, demoCapabilityDeps } from "../../apps/user-app/src/demo/page.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";
import { renderThemedPage } from "../../apps/user-app/src/theme/render.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

/** Fresh databases restart at theme version 1; the process-wide compile cache needs a miss. */
let themeVersionOffset = 0;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "theme_templates" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        membersSeedModule,
        themesSeedModule,
      ]),
    });
    themeVersionOffset += 1;
    await database.sql`
      UPDATE core.themes SET version = version + ${themeVersionOffset} WHERE name = 'default'
    `;
    await run(database);
  });
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

async function renderDemo(
  database: TestDatabase,
  session: UserAppSessionContext | null,
  forumId: string,
  options: { readonly showDeleted?: boolean } = {},
): Promise<{ html: string; errors: readonly string[]; status: number }> {
  const outcome = await buildDemoPage({
    sql: database.sql,
    locale: "en",
    translate,
    session,
    forumId,
    showDeleted: options.showDeleted ?? false,
  });

  const page = await renderThemedPage({
    sql: database.sql,
    boardName: "Bulletin",
    locale: "en",
    translate,
    template: outcome.template,
    // The demo template reads the affectsRender flag (ADR 0010); task 5.4 covers the hash.
    viewModel: { ...outcome.viewModel, flags: { compactTopicList: true } },
    breadcrumbs: outcome.breadcrumbs,
    route: {
      route: demoContract.route,
      requiredIslands:
        outcome.state === "content" ? demoContract.requiredIslands : DEMO_SHELL_ISLANDS,
    },
  });

  return {
    html: page.html,
    errors: page.errors,
    status: outcome.template === "error" ? outcome.status : 200,
  };
}

integrationDescribe("default theme templates", () => {
  test("the seed installs the repository theme files and the demo hook fragment", async () => {
    await withSeededDb(async (database) => {
      const theme = await loadTheme(database.sql, "default");
      const files = await loadDefaultThemeTemplates();

      if (theme === null) {
        throw new Error("expected the default theme");
      }

      expect(theme.theme.name).toBe("default");
      expect([...theme.templates.keys()].sort()).toEqual(Object.keys(files).sort());

      for (const [name, body] of Object.entries(files)) {
        expect(theme.templates.get(name)?.[0]?.body).toBe(body);
      }

      const hooks = await loadHookFragments(database.sql, SEEDED_PLUGIN_GENERATION);
      const repoHooks = await loadDemoHookFragments();

      expect(theme.theme.version).toBeGreaterThanOrEqual(1);
      expect(hooks).toEqual(repoHooks);
    });
  });

  test("renders the home, login and callback pages through the theme pipeline", async () => {
    await withSeededDb(async (database) => {
      const boards = ["home", "login", "callback"] as const;
      const cases = [
        { contract: homeContract, marker: "data-online" },
        { contract: loginContract, marker: "data-login-page" },
        { contract: callbackContract, marker: "data-signing-in" },
      ];

      for (const routeCase of cases) {
        const page = await renderThemedPage({
          sql: database.sql,
          boardName: "Bulletin",
          locale: "en",
          translate,
          template: routeCase.contract.templates.page,
          viewModel: { boardName: "Bulletin", boardDescription: "A friendly place" },
          breadcrumbs: [],
          route: routeCase.contract,
        });

        expect(page.errors).toEqual([]);
        expect(page.html).toContain(routeCase.marker);
        expect(page.html).toContain('data-name="LanguageSwitcher"');
        expect(page.html).toContain("data-theme-header");
        expect(page.html).toContain("data-theme-footer");
      }

      expect(boards).toHaveLength(cases.length);
    });
  });

  test("renders the demo page with header, breadcrumbs, island, hook and overlay slot", async () => {
    await withSeededDb(async (database) => {
      const session = await memberSession(database, "member-1");
      const page = await renderDemo(database, session, "2");

      expect(page.status).toBe(200);
      expect(page.errors).toEqual([]);
      expect(page.html).toContain("data-theme-header");
      expect(page.html).toContain("data-theme-footer");
      expect(page.html).toContain("data-breadcrumbs");
      expect(page.html).toContain('href="/_demo/1"');
      expect(page.html).toContain('<bl-island data-name="LanguageSwitcher"');
      expect(page.html).toContain('<bl-island data-name="SpikeCounter"');
      expect(page.html).toContain("data-demo-hook");
      expect(page.html).toContain("data-overlay-unread");
      expect(page.html).toContain('data-demo-id="2"');
    });
  });

  test("denies a forum the viewer can see but not read", async () => {
    await withSeededDb(async (database) => {
      const session = await memberSession(database, "member-1");

      await database.sql`
        UPDATE core.forum_permissions
        SET actions = actions & ~3
        WHERE forum_id = 2
          AND mask_id = (SELECT id FROM core.masks WHERE key = 'standard')
      `;

      const page = await renderDemo(database, session, "2");

      expect(page.status).toBe(403);
      expect(page.html).toContain("data-theme-error");
      expect(page.html).not.toContain("data-demo-topics");
    });
  });

  test("shows the empty state for a forum with no topics", async () => {
    await withSeededDb(async (database) => {
      const session = await memberSession(database, "member-1");
      const page = await renderDemo(database, session, "4");

      expect(page.status).toBe(200);
      expect(page.html).toContain("data-theme-empty");
    });
  });

  test("locks a password forum until the session has an unlock grant", async () => {
    await withSeededDb(async (database) => {
      const session = await memberSession(database, "member-1");
      const locked = await renderDemo(database, session, "3");

      expect(locked.status).toBe(200);
      expect(locked.html).toContain("data-demo-locked");
      expect(locked.html).toContain("demo-password");
      expect(locked.errors).toEqual([]);

      const [row] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (
          ${session.memberId},
          'user',
          decode(md5(random()::text), 'hex'),
          now() + interval '1 day'
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (row === undefined) {
        throw new Error("could not create a session");
      }

      await database.sql`
        INSERT INTO core.session_grants (session_id, kind, resource_id)
        VALUES (${row.id}, 'forum_password', 3)
      `;

      const unlocked = await renderDemo(database, { ...session, sessionId: row.id }, "3");

      expect(unlocked.status).toBe(200);
      expect(unlocked.html).not.toContain("data-demo-locked");
      expect(unlocked.html).toContain("data-demo-topics");
    });
  });

  test("denies a forum the viewer cannot see", async () => {
    await withSeededDb(async (database) => {
      // Fixture forum 6 has no matrix row for Guests, so it is invisible to them.
      const page = await renderDemo(database, null, "6");

      expect(page.status).toBe(403);
      expect(page.html).toContain("data-theme-error");
      expect(page.html).toContain('data-error-code="forbidden"');
    });
  });

  test("shows the moderator tools only with the moderator power on that forum", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const memberMod = await memberSession(database, "member-mod");
      const superMod = await memberSession(database, "super-mod");

      // `member-mod` moderates forum 1 only; forum 2 has no power there.
      const notAModerator = await renderDemo(database, member, "2");
      const otherForum = await renderDemo(database, memberMod, "2");
      const globallyPowered = await renderDemo(database, superMod, "2");

      expect(notAModerator.html).not.toContain("data-demo-mod-tools");
      expect(otherForum.html).not.toContain("data-demo-mod-tools");
      expect(globallyPowered.html).toContain("data-demo-mod-tools");
    });
  });

  test("a parser-dependent noscript payload never reaches the served HTML", async () => {
    await withSeededDb(async (database) => {
      const payload =
        '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>';

      await database.sql`
        UPDATE core.theme_templates
        SET body = body || ${payload}, version = version + 1
        WHERE name = 'demo'
      `;

      const page = await renderDemo(database, await memberSession(database, "member-1"), "2");

      expect(page.html).not.toContain("noscript");
      expect(page.html).not.toContain("onerror");
      expect(page.errors.some((error) => error.startsWith("sanitise:"))).toBe(true);
    });
  });

  test("the demo builder fails when a view omits a bit it reads", async () => {
    await withSeededDb(async (database) => {
      const session = await memberSession(database, "super-mod");
      const snapshot = await loadPermissionSnapshot(database.sql, session.memberId, {
        tree: FIXTURE_FORUM_TREE,
        sessionId: session.sessionId,
      });
      const narrowed = new CapabilityView({
        tree: FIXTURE_FORUM_TREE,
        bits: snapshot.bits,
        unlocked: snapshot.unlocked,
        view: "demo",
        // The builder reads see_deleted for the moderator controls; omitting it must throw
        // rather than quietly escaping the variant key (ADR 0005).
        deps: demoCapabilityDeps("2").filter((dep) => dep.bit !== "see_deleted"),
      });

      await expect(
        buildDemoPage({
          sql: database.sql,
          locale: "en",
          translate,
          session,
          forumId: "2",
          showDeleted: false,
          capabilityView: narrowed,
        }),
      ).rejects.toThrow(UndeclaredCapabilityError);
    });
  });

  test("hides the moderator tools from members and shows them to moderators", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const moderator = await memberSession(database, "super-mod");

      const memberPage = await renderDemo(database, member, "2");
      const moderatorPage = await renderDemo(database, moderator, "2");

      expect(memberPage.html).not.toContain("data-demo-mod-tools");
      expect(memberPage.html).not.toContain("data-demo-deleted");

      expect(moderatorPage.html).toContain("data-demo-mod-tools");
      expect(moderatorPage.html).not.toContain("data-demo-deleted");

      const deletedPage = await renderDemo(database, moderator, "2", { showDeleted: true });

      expect(deletedPage.html).toContain("data-demo-deleted");
    });
  });

  test("renders the account page with display name, history and language", async () => {
    await withSeededDb(async (database) => {
      const session = await memberSession(database, "member-1");
      const account = await buildAccountPage({
        sql: database.sql,
        memberId: session.memberId,
        locale: "en",
        translate,
      });

      if (account === null) {
        throw new Error("expected the account page");
      }

      const page = await renderThemedPage({
        sql: database.sql,
        boardName: "Bulletin",
        viewer: { isMember: true, displayName: session.displayName },
        locale: "en",
        translate,
        template: "account",
        viewModel: account.viewModel,
        breadcrumbs: account.breadcrumbs,
        route: accountContract,
      });

      expect(page.errors).toEqual([]);
      expect(page.html).toContain("data-account-page");
      expect(page.html).toContain('value="Regular Member One"');
      expect(page.html).toContain("data-account-history-entry");
      expect(page.html).toContain("Regular Member → Regular Member One");
      expect(page.html).toContain("data-account-session-list");
      expect(page.html).toContain('<bl-island data-name="LanguageSwitcher"');
    });
  });

  test("takes a template edit into account on the next render", async () => {
    await withSeededDb(async (database) => {
      const session = await memberSession(database, "member-1");
      const before = await renderDemo(database, session, "2");

      expect(before.html).not.toContain("data-theme-edit");

      await database.sql`
        UPDATE core.theme_templates
        SET body = body || '<p data-theme-edit>edited</p>', version = version + 1
        WHERE name = 'demo'
      `;

      const after = await renderDemo(database, session, "2");

      expect(after.html).toContain("data-theme-edit");
    });
  });

  test("reports a required island the theme omits", async () => {
    await withSeededDb(async (database) => {
      const session = await memberSession(database, "member-1");

      await database.sql`
        UPDATE core.theme_templates
        SET body = replace(body, '{% island "SpikeCounter" counter %}', ''),
            version = version + 1
        WHERE name = 'demo'
      `;

      const page = await renderDemo(database, session, "2");

      expect(page.html).not.toContain('data-name="SpikeCounter"');
      expect(page.errors).toContain(
        'required island "SpikeCounter" is missing from route "/_demo/[id]"',
      );
    });
  });
});
