import { describe, expect, test } from "bun:test";
import {
  createRenderCache,
  forumTag,
  readTagVersion,
  type TagVersionSource,
} from "@bulletin/cache";
import { flushRedirectClicks } from "@bulletin/db/jobs";
import {
  baseSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { type ForumAction, forumActionMask } from "@bulletin/domain/permissions";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { buildBoardIndex } from "../../apps/user-app/src/forums/index.ts";
import { renderForumRoute } from "../../apps/user-app/src/forums/route.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });
const TRUSTED: TagVersionSource = { version: () => "0", isTrusted: () => true };

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "forum_redirects" }, async (database) => {
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

async function createForum(
  database: TestDatabase,
  input: {
    readonly title: string;
    readonly slug: string;
    readonly parentId?: string | null;
    readonly type?: "forum" | "redirect";
    readonly redirectUrl?: string | null;
  },
): Promise<string> {
  const [forum] = (await database.sql`
    INSERT INTO core.forums (parent_id, type, title, slug, redirect_url)
    VALUES (
      ${input.parentId ?? null}, ${input.type ?? "forum"}, ${input.title}, ${input.slug},
      ${input.redirectUrl ?? null}
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (forum === undefined) {
    throw new Error(`Could not create forum ${input.title}`);
  }

  return forum.id;
}

async function setStandardActions(
  database: TestDatabase,
  forumId: string,
  actions: readonly ForumAction[],
): Promise<void> {
  await database.sql`
    INSERT INTO core.forum_permissions (forum_id, mask_id, actions, inherits)
    VALUES (
      ${forumId}, (SELECT id FROM core.masks WHERE key = 'standard'),
      ${forumActionMask(actions)}, false
    )
    ON CONFLICT (forum_id, mask_id) DO UPDATE
      SET actions = EXCLUDED.actions, inherits = false
  `;
}

async function render(database: TestDatabase, ref: string, session: UserAppSessionContext) {
  return renderForumRoute({
    sql: database.sql,
    locale: "en",
    translate,
    session,
    ref,
    pluginsGeneration: 1,
    colourScheme: "system",
    cache: createRenderCache({ tags: TRUSTED }),
    tagVersions: TRUSTED,
  });
}

integrationDescribe("redirect forums and slug URLs", () => {
  test("counts a redirect click in the buffer and folds it into the index without invalidating", async () => {
    await withSeededDb(async (database) => {
      const forum = await createForum(database, {
        title: "Elsewhere",
        slug: "elsewhere",
        parentId: "1",
        type: "redirect",
        redirectUrl: "https://example.test/welcome",
      });
      const before = await readTagVersion(database.sql, forumTag(forum));
      const member = await memberSession(database, "member-1");
      const result = await render(database, `/forum/${forum}-elsewhere`, member);

      expect(result).toMatchObject({
        kind: "redirect",
        status: 302,
        location: "https://example.test/welcome",
        reason: "forum",
      });

      const buffered = (await database.sql`
        SELECT count(*)::int AS count FROM core.forum_redirect_clicks
      `) as Array<{ count: number }>;
      expect(buffered[0]?.count).toBe(1);

      const flushed = await flushRedirectClicks(database.sql);

      expect(flushed).toBe(1);

      const [counter] = (await database.sql`
        SELECT redirect_clicks::text AS clicks FROM core.forums WHERE id = ${forum}
      `) as Array<{ clicks: string }>;
      expect(counter?.clicks).toBe("1");

      const remaining = (await database.sql`
        SELECT count(*)::int AS count FROM core.forum_redirect_clicks
      `) as Array<{ count: number }>;
      expect(remaining[0]?.count).toBe(0);

      // Folding the counter is a read-path write: the forum's or the board's cache tag is unchanged.
      expect(await readTagVersion(database.sql, forumTag(forum))).toBe(before);
      expect(await readTagVersion(database.sql, "board")).toBe("0");

      const index = await buildBoardIndex({
        sql: database.sql,
        locale: "en",
        translate,
        session: member,
      });
      const view = index.viewModel.categories[0]?.forums.find(
        (candidate) => candidate.id === forum,
      );

      expect(view?.redirect?.clicks).toBe("1 click");
    });
  }, 30_000);

  test("a hidden redirect forum returns 404 and records no click", async () => {
    await withSeededDb(async (database) => {
      const forum = await createForum(database, {
        title: "Hidden redirect",
        slug: "hidden-redirect",
        parentId: "1",
        type: "redirect",
        redirectUrl: "https://example.test/hidden",
      });
      await setStandardActions(database, forum, []);
      const result = await render(
        database,
        `/forum/${forum}-hidden-redirect`,
        await memberSession(database, "member-1"),
      );

      expect(result.kind).toBe("page");

      if (result.kind === "page") {
        expect(result.status).toBe(404);
      }

      const buffered = (await database.sql`
        SELECT count(*)::int AS count FROM core.forum_redirect_clicks
      `) as Array<{ count: number }>;
      expect(buffered[0]?.count).toBe(0);
    });
  }, 30_000);

  test("redirects a missing or outdated slug with 301 and resolves only by ID", async () => {
    await withSeededDb(async (database) => {
      const forum = await createForum(database, {
        title: "General Chat",
        slug: "general-chat",
        parentId: "1",
      });
      const member = await memberSession(database, "member-1");

      expect(await render(database, `/forum/${forum}`, member)).toEqual({
        kind: "redirect",
        status: 301,
        location: `/forum/${forum}-general-chat`,
        reason: "slug",
      });
      expect(await render(database, `/forum/${forum}-old-slug`, member)).toEqual({
        kind: "redirect",
        status: 301,
        location: `/forum/${forum}-general-chat`,
        reason: "slug",
      });

      const canonical = await render(database, `/forum/${forum}-general-chat`, member);
      expect(canonical.kind).toBe("page");

      if (canonical.kind === "page") {
        expect(canonical.status).toBe(200);
      }

      await database.sql`UPDATE core.forums SET slug = 'general-discussion' WHERE id = ${forum}`;

      expect(await render(database, `/forum/${forum}-general-chat`, member)).toEqual({
        kind: "redirect",
        status: 301,
        location: `/forum/${forum}-general-discussion`,
        reason: "slug",
      });

      const history = (await database.sql`
        SELECT slug FROM core.slug_history WHERE kind = 'forum' AND resource_id = ${forum}
      `) as Array<{ slug: string }>;
      expect(history.map((row) => row.slug)).toContain("general-chat");
    });
  }, 30_000);
});
