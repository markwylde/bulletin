import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import {
  baseSeedModule,
  forumSeedModule,
  groupsSeedModule,
  membersSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import type { SessionRecord } from "@bulletin/domain/auth";
import {
  allowedThemesForGroups,
  appearanceOptions,
  createChildTheme,
  createThemePreviewToken,
  grantPreviewTheme,
  guestThemeId,
  listThemes,
  loadThemeResources,
  previewThemeForSession,
  readThemeDetail,
  restoreThemeTemplateVersion,
  revertThemeTemplate,
  saveGroupDefaultTheme,
  saveMemberAppearance,
  saveThemeAllowedGroups,
  saveThemeCss,
  saveThemeStrings,
  saveThemeTemplate,
  saveThemeTokens,
  setThemeActive,
} from "@bulletin/domain/themes";
import { createServerT } from "@bulletin/i18n";
import type { StorageClient } from "@bulletin/storage";
import { loadDefaultThemeTemplates, loadTheme } from "@bulletin/templates";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { authorizeStaffRoute, STAFF_ROUTES } from "../../apps/staff-api/src/api.ts";
import {
  exchangePreviewToken,
  saveCssResponse,
  saveStringsResponse,
  saveTemplateResponse,
  saveTokensResponse,
  themePreviewResponse,
  uploadAssetResponse,
} from "../../apps/staff-api/src/themes.ts";
import {
  saveAppearanceResponse,
  themeOptionsResponse,
} from "../../apps/user-api/src/appearance.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderHomeRoute } from "../../apps/user-app/src/home/route.ts";
import { renderThemedPage, renderThemeHead } from "../../apps/user-app/src/theme/render.ts";
import { resolveRequestTheme } from "../../apps/user-app/src/theme/request-theme.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "themes_manage" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        forumSeedModule,
        groupsSeedModule,
        membersSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
}

async function memberId(database: TestDatabase, sub: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT member_id::text AS member_id FROM pii.identities WHERE sub = ${sub}
  `) as Array<{ member_id: string }>;

  if (row === undefined) {
    throw new Error(`Missing member ${sub}`);
  }

  return row.member_id;
}

async function themeId(database: TestDatabase, name: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.themes WHERE name = ${name}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing theme ${name}`);
  }

  return row.id;
}

function expectOk<T>(
  outcome: { readonly ok: true; readonly result: T } | { readonly ok: false },
): T {
  if (!outcome.ok) {
    throw new Error("Expected success");
  }

  return outcome.result;
}

async function childOf(
  database: TestDatabase,
  name: string,
  actorId: string,
  parentId?: string,
): Promise<string> {
  const parent = parentId ?? (await themeId(database, "default"));
  return expectOk(await createChildTheme(database.sql, { name, parentId: parent, actorId })).id;
}

async function child(database: TestDatabase, name: string, actorId: string): Promise<string> {
  const id = await childOf(database, name, actorId);
  await setThemeActive(database.sql, { themeId: id, active: true });
  return id;
}

integrationDescribe("theme management domain", () => {
  test("a child inherits templates, tokens, CSS, assets and strings it does not override", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const parent = await child(database, "resource-parent", admin);
      const childId = await childOf(database, "resource-child", admin, parent);

      await saveThemeTokens(database.sql, {
        themeId: parent,
        scheme: "light",
        tokens: { accent: "#111111", text: "#000000" },
      });
      await saveThemeTokens(database.sql, {
        themeId: childId,
        scheme: "light",
        tokens: { accent: "#222222" },
      });
      await saveThemeCss(database.sql, { themeId: parent, css: ":root { --x: 1; }" });
      await saveThemeStrings(database.sql, {
        themeId: parent,
        strings: [
          { locale: "en", key: "theme.footer", value: "Parent footer" },
          { locale: "es", key: "theme.footer", value: "Pie del padre" },
        ],
      });
      await saveThemeStrings(database.sql, {
        themeId: childId,
        strings: [{ locale: "en", key: "theme.footer", value: "Child footer" }],
      });

      const loaded = await loadTheme(database.sql, childId);

      if (loaded === null) {
        throw new Error("Missing child theme");
      }

      const resources = await loadThemeResources(
        database.sql,
        loaded.chain.map((entry) => entry.id),
      );

      expect(resources.tokens.light).toMatchObject({ accent: "#222222", text: "#000000" });
      expect(resources.css).toBe(":root { --x: 1; }");
      expect(resources.strings.en["theme.footer"]).toBe("Child footer");
      expect(resources.strings.es["theme.footer"]).toBe("Pie del padre");

      // A parent template update flows through when the child does not override it.
      await database.sql`
        INSERT INTO core.theme_templates (theme_id, name, body)
        VALUES (${parent}, 'footer', '<footer>new parent</footer>')
        ON CONFLICT (theme_id, name) DO UPDATE SET body = EXCLUDED.body, version = core.theme_templates.version + 1
      `;
      const after = await loadTheme(database.sql, childId);
      expect(after?.templates.get("footer")?.[0]?.body).toBe("<footer>new parent</footer>");

      // The child's own override still wins after the parent changes.
      await saveThemeTemplate(database.sql, {
        themeId: childId,
        name: "footer",
        body: "<footer>child</footer>",
        actorId: admin,
      });
      const overridden = await loadTheme(database.sql, childId);
      expect(overridden?.templates.get("footer")?.[0]?.body).toBe("<footer>child</footer>");
    });
  }, 60_000);

  test("keeps template versions, restores an old body and reverts to the parent", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const childId = await child(database, "version-child", admin);

      expectOk(
        await saveThemeTemplate(database.sql, {
          themeId: childId,
          name: "footer",
          body: "<footer>one</footer>",
          actorId: admin,
        }),
      );
      expectOk(
        await saveThemeTemplate(database.sql, {
          themeId: childId,
          name: "footer",
          body: "<footer>two</footer>",
          actorId: admin,
        }),
      );
      const before = await readThemeDetail(database.sql, childId);
      const footerVersions = before?.versions.filter((entry) => entry.name === "footer") ?? [];
      expect(footerVersions.length).toBeGreaterThanOrEqual(2);

      const first = footerVersions[footerVersions.length - 1];

      if (first === undefined) {
        throw new Error("No footer version");
      }

      expectOk(
        await restoreThemeTemplateVersion(database.sql, {
          themeId: childId,
          name: "footer",
          version: first.version,
          actorId: admin,
        }),
      );
      expect(
        (await readThemeDetail(database.sql, childId))?.templates.find(
          (entry) => entry.name === "footer",
        )?.body,
      ).toBe(first.body);

      expectOk(
        await revertThemeTemplate(database.sql, {
          themeId: childId,
          name: "footer",
          actorId: admin,
        }),
      );
      const reverted = await readThemeDetail(database.sql, childId);
      const footer = reverted?.templates.find((entry) => entry.name === "footer");
      expect(footer?.inheritedFrom).toBe("default");
      expect(footer?.parentBody).not.toBeNull();
    });
  }, 60_000);

  test("reverts a grandchild override to an inherited parent template", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const middle = await child(database, "middle-theme", admin);
      const grandchild = await childOf(database, "grandchild-theme", admin, middle);
      expectOk(
        await saveThemeTemplate(database.sql, {
          themeId: middle,
          name: "footer",
          body: "<footer>middle footer</footer>",
          actorId: admin,
        }),
      );
      expectOk(
        await saveThemeTemplate(database.sql, {
          themeId: grandchild,
          name: "footer",
          body: "<footer>grandchild footer</footer>",
          actorId: admin,
        }),
      );

      const before = await readThemeDetail(database.sql, grandchild);
      expect(before?.templates.find((entry) => entry.name === "footer")?.parentBody).toBe(
        "<footer>middle footer</footer>",
      );

      expectOk(
        await revertThemeTemplate(database.sql, {
          themeId: grandchild,
          name: "footer",
          actorId: admin,
        }),
      );

      const detail = await readThemeDetail(database.sql, grandchild);
      const footer = detail?.templates.find((entry) => entry.name === "footer");
      expect(footer?.body).toBe("<footer>middle footer</footer>");
      expect(footer?.inheritedFrom).toBe("middle-theme");
    });
  }, 60_000);

  test("the theme routes deny a member without acp.themes", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");
      const admin = await memberId(database, "admin");

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        SELECT id, 'acp.access', to_jsonb(true) FROM core.groups WHERE key = 'members'
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;
      const route = STAFF_ROUTES.find((entry) => entry.id === "themes.list");

      if (route === undefined) {
        throw new Error("Missing themes.list route");
      }

      const deny = await authorizeStaffRoute(route, {
        request: new Request("http://staff.localhost/api/staff/themes"),
        url: new URL("http://staff.localhost/api/staff/themes"),
        session: { memberId: member, lastAuthAt: new Date() } as SessionRecord,
        sql: database.sql,
        checks: [],
      });
      const allow = await authorizeStaffRoute(route, {
        request: new Request("http://staff.localhost/api/staff/themes"),
        url: new URL("http://staff.localhost/api/staff/themes"),
        session: { memberId: admin, lastAuthAt: new Date() } as SessionRecord,
        sql: database.sql,
        checks: [],
      });

      expect(deny.status).toBe(403);
      expect(allow.status).toBe(200);
    });
  }, 60_000);
});

integrationDescribe("theme CSS, assets, strings and preview", () => {
  test("rejects an external CSS import and saves filtered local CSS", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const childId = await child(database, "css-child", admin);
      const blocked = await saveCssResponse(
        database.sql,
        admin,
        new Request("http://staff.localhost/api/staff/themes/css", {
          method: "POST",
          body: JSON.stringify({
            themeId: childId,
            css: '@import url("https://evil.example/x.css");',
          }),
        }),
      );

      expect(blocked.status).toBe(400);
      expect(await blocked.json()).toMatchObject({ code: "css_import" });

      const saved = await saveCssResponse(
        database.sql,
        admin,
        new Request("http://staff.localhost/api/staff/themes/css", {
          method: "POST",
          body: JSON.stringify({
            themeId: childId,
            css: ".logo { background: url('/theme-assets/logo.png'); }",
          }),
        }),
      );

      expect(saved.status).toBe(200);
      expect((await readThemeDetail(database.sql, childId))?.css).toContain(
        "/theme-assets/logo.png",
      );
    });
  }, 60_000);

  test("stores uploaded assets and inherits them from the parent", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const parent = await child(database, "asset-parent", admin);
      const childId = await childOf(database, "asset-child", admin, parent);
      const objects = new Map<string, Uint8Array>();
      const storage = {
        put: async (key: string, data: Uint8Array) => {
          objects.set(key, data);
          return data.byteLength;
        },
        delete: async (key: string) => {
          objects.delete(key);
        },
      } as unknown as StorageClient;
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

      const uploaded = await uploadAssetResponse(
        database.sql,
        storage,
        admin,
        new Request("http://staff.localhost/api/staff/themes/assets", {
          method: "POST",
          body: JSON.stringify({ themeId: parent, name: "logo.png", data: png }),
        }),
      );

      expect(uploaded.status).toBe(200);
      expect(objects.size).toBe(1);

      const loaded = await loadTheme(database.sql, childId);
      const resources = await loadThemeResources(
        database.sql,
        loaded?.chain.map((entry) => entry.id) ?? [],
      );
      expect(resources.assets.map((asset) => asset.name)).toEqual(["logo.png"]);
    });
  }, 60_000);

  test("stores per-locale string overrides and reports them in the resources", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const childId = await child(database, "strings-child", admin);
      const response = await saveStringsResponse(
        database.sql,
        admin,
        new Request("http://staff.localhost/api/staff/themes/strings", {
          method: "POST",
          body: JSON.stringify({
            themeId: childId,
            strings: [
              { locale: "en", key: "theme.footer", value: "Custom footer" },
              { locale: "fr", key: "theme.footer", value: "Pied personnalisé" },
            ],
          }),
        }),
      );

      expect(response.status).toBe(200);
      const loaded = await loadTheme(database.sql, childId);
      const resources = await loadThemeResources(
        database.sql,
        loaded?.chain.map((entry) => entry.id) ?? [],
      );
      expect(resources.strings.en["theme.footer"]).toBe("Custom footer");
      expect(resources.strings.fr["theme.footer"]).toBe("Pied personnalisé");

      const loadedTheme = await loadTheme(database.sql, childId);

      if (loadedTheme === null) {
        throw new Error("Missing the string-override theme");
      }

      const page = await renderThemedPage({
        sql: database.sql,
        boardName: "Bulletin",
        locale: "en",
        translate: createServerT("en", { shipped: USER_CATALOGS }),
        template: "footer",
        viewModel: { year: 2026 },
        breadcrumbs: [],
        route: { route: "/", requiredIslands: [] },
        theme: loadedTheme,
        regions: [],
      });

      expect(page.html).toContain("Custom footer");
      expect(page.html).not.toContain("Bulletin community");
    });
  }, 60_000);

  test("preview grants belong to one session and restricted guest themes fall back", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const childId = await child(database, "preview-child", admin);
      const [session] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (${admin}, 'user', decode(md5(random()::text), 'hex'), now() + interval '1 day')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (session === undefined) {
        throw new Error("Could not create a session");
      }

      const signed = await exchangePreviewToken(
        database.sql,
        session.id,
        admin,
        "preview-secret",
        createThemePreviewToken({ themeId: childId, memberId: admin }, "preview-secret"),
      );
      expect(signed).toEqual({ ok: true, themeId: childId });

      const wrongMember = await exchangePreviewToken(
        database.sql,
        session.id,
        "999999",
        "preview-secret",
        createThemePreviewToken({ themeId: childId, memberId: admin }, "preview-secret"),
      );
      expect(wrongMember).toEqual({ ok: false });

      const previewResponse = themePreviewResponse({
        themeId: childId,
        memberId: admin,
        secret: "preview-secret",
        userOrigin: "http://bulletin.localhost:8080",
        returnTo: "/forum/5-off-topic",
      });
      const previewBody = (await previewResponse.json()) as { url: string };
      expect(previewBody.url).toContain("/_preview?token=");
      expect(previewBody.url).toContain("return_to=%2Fforum%2F5-off-topic");

      expect(await grantPreviewTheme(database.sql, session.id, childId)).toBe(true);
      expect(await previewThemeForSession(database.sql, session.id, admin)).toBe(childId);
      expect(await previewThemeForSession(database.sql, "0", admin)).toBeNull();

      const [vip] = (await database.sql`
        SELECT id FROM core.groups WHERE key = 'vip'
      `) as Array<{ id: string }>;
      const [guests] = (await database.sql`
        SELECT id FROM core.groups WHERE key = 'guests'
      `) as Array<{ id: string }>;

      if (vip === undefined || guests === undefined) {
        throw new Error("Missing seeded groups");
      }

      await database.sql`
        INSERT INTO core.theme_allowed_groups (theme_id, group_id)
        VALUES (${childId}, ${vip.id})
      `;
      expect(await guestThemeId(database.sql, childId)).toBeNull();

      await database.sql`DELETE FROM core.theme_allowed_groups WHERE theme_id = ${childId}`;
      await database.sql`
        INSERT INTO core.theme_allowed_groups (theme_id, group_id)
        VALUES (${childId}, ${guests.id})
      `;
      expect(await guestThemeId(database.sql, childId)).toBe(childId);
    });
  }, 60_000);

  test("preview grants are scoped to one session and guest cookies are validated", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const other = await memberId(database, "member-1");
      const childId = await child(database, "request-theme-child", admin);
      const [session] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (${admin}, 'user', decode(md5(random()::text), 'hex'), now() + interval '1 day')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const [otherSession] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (${other}, 'user', decode(md5(random()::text), 'hex'), now() + interval '1 day')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (session === undefined || otherSession === undefined) {
        throw new Error("Could not create sessions");
      }

      await grantPreviewTheme(database.sql, session.id, childId);
      const context = (memberId: string, sessionId: string) => ({
        memberId,
        sessionId,
        reauthAt: new Date().toISOString(),
        locale: "en" as const,
        displayName: "Admin",
      });

      expect(
        await resolveRequestTheme(database.sql, null, context(admin, session.id)),
      ).toMatchObject({ themeId: childId, preview: true });
      expect(
        await resolveRequestTheme(database.sql, null, context(other, otherSession.id)),
      ).toMatchObject({ preview: false });

      const [vip] = (await database.sql`
        SELECT id FROM core.groups WHERE key = 'vip'
      `) as Array<{ id: string }>;

      if (vip === undefined) {
        throw new Error("Missing VIP group");
      }

      await database.sql`
        INSERT INTO core.theme_allowed_groups (theme_id, group_id) VALUES (${childId}, ${vip.id})
      `;
      expect(await resolveRequestTheme(database.sql, `bp=en.${childId}.dark`, null)).toMatchObject({
        invalidGuestTheme: true,
      });
      expect(
        (await resolveRequestTheme(database.sql, `bp=en.${childId}.dark`, null)).themeId,
      ).not.toBe(childId);

      await database.sql`DELETE FROM core.theme_allowed_groups WHERE theme_id = ${childId}`;
      expect(await resolveRequestTheme(database.sql, `bp=en.${childId}.dark`, null)).toMatchObject({
        themeId: childId,
        invalidGuestTheme: false,
        scheme: "dark",
      });
    });
  }, 60_000);

  test("a preview renders privately while other viewers keep the default cache entry", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const childId = await child(database, "preview-cache-child", admin);
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });
      const cache = createRenderCache({ tags: versions });
      const translate = createServerT("en", { shipped: USER_CATALOGS });
      const render = (themeId: string | null, preview: boolean) =>
        renderHomeRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
          themeId,
          preview,
        });

      try {
        const first = await render(null, false);
        const preview = await render(childId, true);
        const other = await render(null, false);

        expect(first.cache).not.toBeNull();
        expect(preview.cache).toBeNull();
        expect(preview.variant).not.toBe(first.variant);
        expect(other.cache).toBe("hit");
        expect(other.html).toBe(first.html);
      } finally {
        await versions.close();
      }
    });
  }, 60_000);

  test("applies VIP availability, per-group defaults and the lost-access fallback", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const other = await memberId(database, "member-1");
      const theme = await child(database, "vip-theme", admin);
      const groups = (await database.sql`
        SELECT id::text AS id, key FROM core.groups WHERE key IN ('members', 'vip', 'guests')
      `) as Array<{ id: string; key: string }>;
      const group = (key: string) => groups.find((entry) => entry.key === key)?.id ?? "";

      expect(
        await saveThemeAllowedGroups(database.sql, {
          themeId: theme,
          groupIds: [group("vip")],
        }),
      ).toMatchObject({ ok: true });

      const memberThemes = await allowedThemesForGroups(database.sql, [group("members")]);
      const vipThemes = await allowedThemesForGroups(database.sql, [group("vip")]);
      expect(memberThemes.some((entry) => entry.id === theme)).toBe(false);
      expect(vipThemes.some((entry) => entry.id === theme)).toBe(true);

      // A VIP member can choose the VIP theme.
      const vipMember = await memberId(database, "vip-member");
      expect(
        await saveMemberAppearance(database.sql, vipMember, {
          themeId: theme,
          scheme: "dark",
        }),
      ).toMatchObject({ ok: true });
      expect(await appearanceOptions(database.sql, vipMember)).toMatchObject({
        themeId: theme,
        scheme: "dark",
      });

      // A non-VIP member cannot choose it.
      expect(
        await saveMemberAppearance(database.sql, other, { themeId: theme, scheme: "system" }),
      ).toMatchObject({ ok: false, code: "not_found" });

      // Distinct primary, secondary and board defaults make the fallback unambiguous.
      const primaryDefault = await child(database, "vip-primary-default", admin);
      const secondaryDefault = await child(database, "members-secondary-default", admin);
      expect(
        await saveGroupDefaultTheme(database.sql, {
          groupId: group("vip"),
          themeId: primaryDefault,
        }),
      ).toMatchObject({ ok: true });
      expect(
        await saveGroupDefaultTheme(database.sql, {
          groupId: group("members"),
          themeId: secondaryDefault,
        }),
      ).toMatchObject({ ok: true });

      // Lost access: revoke the VIP allowance after the choice was saved.
      expect(
        await saveThemeAllowedGroups(database.sql, {
          themeId: theme,
          groupIds: [group("guests")],
        }),
      ).toMatchObject({ ok: true });
      const lost = await appearanceOptions(database.sql, vipMember);
      expect(lost.themeId).toBe(primaryDefault);

      // The Guests group's default theme is used when no cookie names one.
      expect(
        await saveGroupDefaultTheme(database.sql, {
          groupId: group("guests"),
          themeId: theme,
        }),
      ).toMatchObject({ ok: true });
      expect(await appearanceOptions(database.sql, null)).toMatchObject({
        themeId: theme,
      });
    });
  }, 60_000);

  test("serves chooser options to guests and saves a member's theme and scheme", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const theme = await child(database, "chooser-theme", admin);
      const [guests] = (await database.sql`
        SELECT id::text AS id FROM core.groups WHERE key = 'guests'
      `) as Array<{ id: string }>;

      if (guests === undefined) {
        throw new Error("Missing Guests group");
      }

      await saveThemeAllowedGroups(database.sql, {
        themeId: theme,
        groupIds: [guests.id],
      });

      const guestRequest = new Request("http://bulletin.localhost/api/theme-options", {
        headers: { cookie: `bp=en.${theme}.dark` },
      });
      const guestOptions = (await (
        await themeOptionsResponse(database.sql, guestRequest, null)
      ).json()) as { member: boolean; themeId: string; scheme: string };

      expect(guestOptions).toMatchObject({ member: false, themeId: theme, scheme: "dark" });

      // The guest cookie naming a theme outside the Guests list falls back to the default.
      await saveThemeAllowedGroups(database.sql, { themeId: theme, groupIds: [] });
      await saveThemeAllowedGroups(database.sql, {
        themeId: theme,
        groupIds: [guests.id],
      });
      await database.sql`
        INSERT INTO core.theme_allowed_groups (theme_id, group_id)
        SELECT ${theme}, id FROM core.groups WHERE key = 'vip'
      `;
      await database.sql`
        DELETE FROM core.theme_allowed_groups
        WHERE theme_id = ${theme}
          AND group_id NOT IN (SELECT id FROM core.groups WHERE key = 'vip')
      `;
      const restricted = (await (
        await themeOptionsResponse(
          database.sql,
          new Request("http://bulletin.localhost/api/theme-options", {
            headers: { cookie: `bp=en.${theme}.dark` },
          }),
          null,
        )
      ).json()) as { themeId: string | null };

      expect(restricted.themeId).not.toBe(theme);

      // A member saves a choice through the user-api handler.
      await saveThemeAllowedGroups(database.sql, { themeId: theme, groupIds: [] });
      const saved = await saveAppearanceResponse(
        database.sql,
        { memberId: member },
        new Request("http://bulletin.localhost/api/me/appearance", {
          method: "POST",
          body: JSON.stringify({ themeId: theme, scheme: "dark" }),
        }),
      );
      expect(saved.status).toBe(200);

      const memberOptions = (await (
        await themeOptionsResponse(
          database.sql,
          new Request("http://bulletin.localhost/api/theme-options"),
          { memberId: member },
        )
      ).json()) as { member: boolean; themeId: string | null; scheme: string };

      expect(memberOptions).toMatchObject({ member: true, themeId: theme, scheme: "dark" });

      // A theme outside the member's groups is refused.
      const denied = await saveAppearanceResponse(
        database.sql,
        { memberId: member },
        new Request("http://bulletin.localhost/api/me/appearance", {
          method: "POST",
          body: JSON.stringify({ themeId: "999999", scheme: "dark" }),
        }),
      );
      expect(denied.status).toBe(404);
    });
  }, 60_000);

  test("keeps new themes inactive until activation and replaces previews atomically", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const defaultId = await themeId(database, "default");
      const inactive = expectOk(
        await createChildTheme(database.sql, {
          name: "inactive-theme",
          parentId: defaultId,
          actorId: admin,
        }),
      ).id;
      const options = await appearanceOptions(database.sql, member);

      expect(options.themes.some((entry) => entry.id === inactive)).toBe(false);
      expect(await guestThemeId(database.sql, inactive)).toBeNull();
      expect(
        await saveMemberAppearance(database.sql, member, {
          themeId: inactive,
          scheme: "system",
        }),
      ).toMatchObject({ ok: false, code: "not_found" });

      // Previewing an inactive theme is still allowed for staff.
      const [session] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (${admin}, 'user', decode(md5(random()::text), 'hex'), now() + interval '1 day')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (session === undefined) {
        throw new Error("Could not create the preview session");
      }

      const second = expectOk(
        await createChildTheme(database.sql, {
          name: "second-preview-theme",
          parentId: defaultId,
          actorId: admin,
        }),
      ).id;
      await grantPreviewTheme(database.sql, session.id, inactive);
      await grantPreviewTheme(database.sql, session.id, second);
      expect(await previewThemeForSession(database.sql, session.id, admin)).toBe(second);

      // Revoking acp.themes stops the existing preview immediately.
      await database.sql`
        DELETE FROM core.group_settings
        WHERE key = 'acp.themes'
          AND group_id IN (SELECT id FROM core.groups WHERE key = 'administrators')
      `;
      expect(await previewThemeForSession(database.sql, session.id, admin)).toBeNull();

      expect(await setThemeActive(database.sql, { themeId: inactive, active: true })).toMatchObject(
        {
          ok: true,
        },
      );
      const activated = await appearanceOptions(database.sql, member);
      expect(activated.themes.some((entry) => entry.id === inactive)).toBe(true);

      const [defaultTheme] = (await database.sql`
        SELECT id::text AS id FROM core.themes WHERE name = 'default'
      `) as Array<{ id: string }>;
      expect(
        await setThemeActive(database.sql, { themeId: defaultTheme?.id ?? "0", active: false }),
      ).toMatchObject({ ok: false, code: "protected_theme" });
    });
  }, 60_000);

  test("rejects template, token and CSS saves that break the installed theme checks", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const childId = await child(database, "save-checks-child", admin);
      const templates = await loadDefaultThemeTemplates();
      const topicWithoutEditor = (templates.topic ?? "").replace(
        /\{%-?\s*island\s+"Editor"[^%]*%\}/g,
        "",
      );
      const template = await saveTemplateResponse(
        database.sql,
        admin,
        new Request("http://staff.localhost/api/staff/themes/template", {
          method: "POST",
          body: JSON.stringify({
            themeId: childId,
            name: "topic",
            body: topicWithoutEditor,
          }),
        }),
      );
      expect(template.status).toBe(400);
      expect(await template.json()).toMatchObject({ code: "checks_failed" });

      const tokens = await saveTokensResponse(
        database.sql,
        admin,
        new Request("http://staff.localhost/api/staff/themes/tokens", {
          method: "POST",
          body: JSON.stringify({
            themeId: childId,
            scheme: "light",
            tokens: { accent: "#ffffff", bg: "#ffffff" },
          }),
        }),
      );
      expect(tokens.status).toBe(400);
      expect(await tokens.json()).toMatchObject({ code: "checks_failed" });

      const escaped = await saveTokensResponse(
        database.sql,
        admin,
        new Request("http://staff.localhost/api/staff/themes/tokens", {
          method: "POST",
          body: JSON.stringify({
            themeId: childId,
            scheme: "light",
            tokens: { accent: "u\\72l(/not-a-theme-asset)" },
          }),
        }),
      );
      expect(escaped.status).toBe(400);
      expect(await escaped.json()).toMatchObject({ code: "invalid_theme" });

      const firstTokens = await saveTokensResponse(
        database.sql,
        admin,
        new Request("http://staff.localhost/api/staff/themes/tokens", {
          method: "POST",
          body: JSON.stringify({
            themeId: childId,
            scheme: "light",
            tokens: {
              bg: "#000000",
              surface: "#111111",
              "surface-muted": "#222222",
              text: "#ffffff",
              muted: "#cccccc",
              border: "#333333",
              accent: "#9fc2ff",
              "accent-text": "#0d1420",
              "accent-soft": "#1e2a3a",
              danger: "#ff9d9d",
            },
          }),
        }),
      );
      expect(firstTokens.status).toBe(200);

      // Removing the text override exposes the inherited dark text on the black background.
      const removedText = await saveTokensResponse(
        database.sql,
        admin,
        new Request("http://staff.localhost/api/staff/themes/tokens", {
          method: "POST",
          body: JSON.stringify({
            themeId: childId,
            scheme: "light",
            tokens: { bg: "#000000" },
          }),
        }),
      );
      expect(removedText.status).toBe(400);
      expect(await removedText.json()).toMatchObject({ code: "checks_failed" });

      const css = await saveCssResponse(
        database.sql,
        admin,
        new Request("http://staff.localhost/api/staff/themes/css", {
          method: "POST",
          body: JSON.stringify({
            themeId: childId,
            css: "body { min-width: 2000px; }",
          }),
        }),
      );
      expect(css.status).toBe(400);
      expect(await css.json()).toMatchObject({
        code: "checks_failed",
        issues: [expect.objectContaining({ code: "responsive" })],
      });
    });
  }, 60_000);

  test("a theme head override restyles metadata but cannot drop or change robots and canonical", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const childId = await child(database, "head-override-child", admin);
      const save = (body: string) =>
        saveTemplateResponse(
          database.sql,
          admin,
          new Request("http://staff.localhost/api/staff/themes/template", {
            method: "POST",
            body: JSON.stringify({ themeId: childId, name: "head", body }),
          }),
        );

      // Save-time required-meta validation.
      const missing = await save('<title>{{ seo.title }}</title>\n<meta name="x" content="y">');
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({
        code: "checks_failed",
        issues: expect.arrayContaining([
          { code: "missing_meta", template: "head", meta: "robots" },
          { code: "missing_meta", template: "head", meta: "canonical" },
        ]),
      });

      const stylesheet = await save(
        [
          "<title>{{ seo.title }}</title>",
          '<meta name="robots" content="{{ seo.robots }}">',
          '<link rel="canonical" href="{{ seo.canonical }}">',
          '<link rel="stylesheet" href="/x.css">',
        ].join("\n"),
      );
      expect(stylesheet.status).toBe(400);
      expect(await stylesheet.json()).toMatchObject({
        code: "checks_failed",
        issues: [{ code: "head_element", template: "head", element: "link" }],
      });

      const valid = await save(
        [
          "<title>{{ seo.title }} (custom head)</title>",
          '<meta name="robots" content="{{ seo.robots }}">',
          '<link rel="canonical" href="{{ seo.canonical }}">',
          '<meta name="theme-color" content="#123456">',
        ].join("\n"),
      );
      expect(valid.status).toBe(200);

      const seo = {
        title: "Members <b>·</b> Bulletin",
        description: "Browse the members.",
        canonical: "https://board.test/members",
        robots: "noindex",
        type: "website",
        locale: "en",
        alternates: [
          { hreflang: "en", href: "https://board.test/members" },
          { hreflang: "es", href: "https://board.test/members?lang=es" },
          { hreflang: "fr", href: "https://board.test/members?lang=fr" },
          { hreflang: "x-default", href: "https://board.test/members" },
        ],
      };
      const input = {
        sql: database.sql,
        themeId: childId,
        pluginsGeneration: 1,
        translate: createServerT("en", { shipped: USER_CATALOGS }),
        boardName: "Bulletin",
        seo,
      };
      const custom = await renderThemeHead(input);

      expect(custom).toContain(
        "<title>Members &lt;b&gt;·&lt;/b&gt; Bulletin (custom head)</title>",
      );
      expect(custom).toContain('<meta name="theme-color" content="#123456">');
      expect(custom).toContain('<meta name="robots" content="noindex">');
      expect(custom).toContain('<link rel="canonical" href="https://board.test/members">');
      expect(custom).toContain('hreflang="es" href="https://board.test/members?lang=es"');

      // A stored override that bypassed the save check (e.g. installed before it existed)
      // is still enforced at render time.
      expectOk(
        await saveThemeTemplate(database.sql, {
          themeId: childId,
          name: "head",
          body: '<title>{{ seo.title }}</title><meta name="robots" content="index, follow">',
          actorId: admin,
        }),
      );
      const enforced = await renderThemeHead(input);

      expect(enforced).not.toContain("index, follow");
      expect(enforced).toContain('<meta name="robots" content="noindex">');
      expect(enforced).toContain('<link rel="canonical" href="https://board.test/members">');

      // The default theme renders the full set.
      const fallback = await renderThemeHead({ ...input, themeId: null });
      expect(fallback).toContain('<meta property="og:url" content="https://board.test/members">');
      expect(fallback).toContain('<meta name="twitter:card" content="summary">');
    });
  }, 60_000);

  test("renders the themeId a page passes instead of silently using the default", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const childId = await child(database, "page-theme-child", admin);
      expectOk(
        await saveThemeTemplate(database.sql, {
          themeId: childId,
          name: "footer",
          body: '<footer data-theme-variant="page-child">child footer</footer>',
          actorId: admin,
        }),
      );

      const page = await renderThemedPage({
        sql: database.sql,
        boardName: "Bulletin",
        locale: "en",
        translate: createServerT("en", { shipped: USER_CATALOGS }),
        template: "footer",
        themeId: childId,
        viewModel: { year: 2026, flags: {} },
        breadcrumbs: [],
        route: { route: "/", requiredIslands: [] },
        regions: [],
      });

      expect(page.html).toContain('data-theme-variant="page-child"');
    });
  }, 60_000);

  test("lists the bundled and custom themes with their parent", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const childId = await child(database, "listed-child", admin);
      const themes = await listThemes(database.sql);
      const listed = themes.find((entry) => entry.id === childId);

      expect(listed).toMatchObject({
        name: "listed-child",
        source: "custom",
        parentName: "default",
      });
      expect(themes.find((entry) => entry.name === "default")?.source).toBe("core");
    });
  }, 60_000);
});
