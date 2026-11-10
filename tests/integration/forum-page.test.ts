import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions, type TagVersionSource } from "@bulletin/cache";
import {
  baseSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { displayNameSkeleton } from "@bulletin/domain/member";
import { type ForumAction, forumActionMask } from "@bulletin/domain/permissions";
import { createServerT } from "@bulletin/i18n";
import { assertCacheVariants, type VariantCase } from "@bulletin/test-utils/cache-variants";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
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

  await withTestDatabase({ adminUrl, prefix: "forum_page" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
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

async function createMember(
  database: TestDatabase,
  name: string,
  groupKeys: readonly string[],
): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES (${name}, ${displayNameSkeleton(name)})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error(`Could not create ${name}`);
  }

  for (const [index, key] of groupKeys.entries()) {
    await database.sql`
      INSERT INTO core.member_groups (member_id, group_id, is_primary)
      SELECT ${member.id}, g.id, ${index === 0}
      FROM core.groups g
      WHERE g.key = ${key}
    `;
  }

  return member.id;
}

interface ForumInput {
  readonly title: string;
  readonly slug: string;
  readonly parentId?: string | null;
  readonly type?: "category" | "forum" | "redirect";
  readonly rules?: string;
  readonly description?: string;
  readonly showModerators?: boolean;
}

async function createForum(database: TestDatabase, input: ForumInput): Promise<string> {
  const [forum] = (await database.sql`
    INSERT INTO core.forums (
      parent_id, type, title, slug, rules, description, show_moderators
    )
    VALUES (
      ${input.parentId ?? null}, ${input.type ?? "forum"}, ${input.title}, ${input.slug},
      ${input.rules ?? ""}, ${input.description ?? ""}, ${input.showModerators ?? true}
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (forum === undefined) {
    throw new Error(`Could not create forum ${input.title}`);
  }

  return forum.id;
}

async function forumHref(database: TestDatabase, forumId: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT slug FROM core.forums WHERE id = ${forumId}
  `) as Array<{ slug: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${forumId}`);
  }

  return `/forum/${forumId}-${row.slug}`;
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

async function render(
  database: TestDatabase,
  ref: string,
  session: UserAppSessionContext | null,
  options: {
    readonly prefix?: string | null;
    readonly cache?: ReturnType<typeof createRenderCache>;
    readonly tagVersions?: TagVersionSource;
    readonly now?: Date;
  } = {},
) {
  return renderForumRoute({
    sql: database.sql,
    locale: "en",
    translate,
    session,
    ref,
    prefix: options.prefix ?? null,
    pluginsGeneration: 1,
    colourScheme: "system",
    cache: options.cache ?? createRenderCache({ tags: options.tagVersions ?? TRUSTED }),
    tagVersions: options.tagVersions ?? TRUSTED,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

async function unlockedSession(database: TestDatabase, memberId: string): Promise<string> {
  const [session] = (await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
    VALUES (${memberId}, 'user', decode(md5(random()::text), 'hex'), now() + interval '1 day')
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (session === undefined) {
    throw new Error("Could not create session");
  }

  await database.sql`
    INSERT INTO core.session_grants (session_id, kind, resource_id)
    VALUES (${session.id}, 'forum_password', 3)
  `;

  return session.id;
}

integrationDescribe("forum page", () => {
  test("renders every ancestor as a breadcrumb for a five-level-deep forum", async () => {
    await withSeededDb(async (database) => {
      const category = await forumHref(database, "1");
      const level2 = await forumHref(database, "2");
      let parent = "2";
      const ids: string[] = [];

      for (let level = 3; level <= 6; level += 1) {
        parent = await createForum(database, {
          title: `Level ${level}`,
          slug: `level-${level}`,
          parentId: parent,
        });
        ids.push(parent);
      }

      const leaf = ids.at(-1);

      if (leaf === undefined) {
        throw new Error("Missing leaf forum");
      }

      const member = await memberSession(database, "member-1");
      const result = await render(database, await forumHref(database, leaf), member);

      expect(result.kind).toBe("page");

      if (result.kind !== "page") {
        return;
      }

      expect(result.status).toBe(200);
      expect(result.html).toContain("data-breadcrumbs");
      expect(result.html).toContain(category);
      expect(result.html).toContain(level2);

      for (const id of ids.slice(0, -1)) {
        expect(result.html).toContain(await forumHref(database, id));
      }

      expect(result.html).toContain("Level 6");

      // Every normal forum links to its direct children, so the five levels can be navigated
      // from the top without going back to the index.
      const chain = ["2", ...ids];

      for (let index = 0; index < chain.length - 1; index += 1) {
        const parentId = chain[index];
        const childId = chain[index + 1];

        if (parentId === undefined || childId === undefined) {
          continue;
        }

        const parentPage = await render(database, await forumHref(database, parentId), member);

        expect(parentPage.kind).toBe("page");

        if (parentPage.kind === "page") {
          expect(parentPage.html).toContain(`data-forum-child="${childId}"`);
        }
      }
    });
  }, 30_000);

  test("shows the rules box as escaped plain text and enumerates available prefixes", async () => {
    await withSeededDb(async (database) => {
      const rules = "<script>alert(1)</script>\nBe kind.";
      await database.sql`
        UPDATE core.forums SET rules = ${rules} WHERE id = 2
      `;
      const [publicPrefix] = (await database.sql`
        INSERT INTO core.prefixes (key, colour) VALUES ('question', '#3157c7') RETURNING id
      `) as Array<{ id: string }>;
      const [staffPrefix] = (await database.sql`
        INSERT INTO core.prefixes (key, colour) VALUES ('staff_only', '#a02a2a') RETURNING id
      `) as Array<{ id: string }>;

      if (publicPrefix === undefined || staffPrefix === undefined) {
        throw new Error("Could not create prefixes");
      }

      await database.sql`
        INSERT INTO core.prefix_labels (prefix_id, locale, label)
        VALUES (${publicPrefix.id}, 'en', 'Question'), (${staffPrefix.id}, 'en', 'Staff only')
      `;
      await database.sql`
        INSERT INTO core.forum_prefixes (forum_id, prefix_id)
        VALUES (2, ${publicPrefix.id}), (2, ${staffPrefix.id})
      `;
      await database.sql`
        INSERT INTO core.prefix_groups (prefix_id, group_id)
        SELECT ${staffPrefix.id}, id FROM core.groups WHERE key = 'administrators'
      `;

      const member = await memberSession(database, "member-1");
      const memberPage = await render(database, await forumHref(database, "2"), member);

      expect(memberPage.kind).toBe("page");

      if (memberPage.kind !== "page") {
        return;
      }

      expect(memberPage.html).toContain("data-rules");
      expect(memberPage.html).toContain("Be kind.");
      expect(memberPage.html).not.toContain("<script>alert(1)</script>");
      expect(memberPage.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(memberPage.html).toContain('data-prefix-key="question"');
      expect(memberPage.html).not.toContain('data-prefix-key="staff_only"');

      // Asking for a prefix the viewer may not use does not select it.
      const restricted = await render(database, await forumHref(database, "2"), member, {
        prefix: "staff_only",
      });

      if (restricted.kind === "page") {
        expect(restricted.html).toContain("data-prefix-all");
        expect(restricted.html).not.toContain('data-prefix-key="staff_only"');
      }

      const admin = await memberSession(database, "admin");
      const adminPage = await render(database, await forumHref(database, "2"), admin, {
        prefix: "staff_only",
      });

      if (adminPage.kind === "page") {
        expect(adminPage.html).toContain('data-prefix-key="staff_only"');
        expect(adminPage.html).toContain("Staff only");
      }

      await database.sql`UPDATE core.forums SET prefix_mode = 'none' WHERE id = 2`;
      const disabled = await render(database, await forumHref(database, "2"), member);

      if (disabled.kind === "page") {
        expect(disabled.html).not.toContain("data-prefix-filter");
        expect(disabled.html).not.toContain('data-prefix-key="question"');
      }
    });
  }, 30_000);

  test("keeps a group-restricted prefix out of a regular member's warm-cache variant", async () => {
    await withSeededDb(async (database) => {
      const [prefix] = (await database.sql`
        INSERT INTO core.prefixes (key, colour) VALUES ('vip_only', '#c0a000') RETURNING id
      `) as Array<{ id: string }>;

      if (prefix === undefined) {
        throw new Error("Could not create prefix");
      }

      await database.sql`
        INSERT INTO core.prefix_labels (prefix_id, locale, label)
        VALUES (${prefix.id}, 'en', 'VIP only')
      `;
      await database.sql`
        INSERT INTO core.forum_prefixes (forum_id, prefix_id) VALUES (2, ${prefix.id})
      `;
      await database.sql`
        INSERT INTO core.prefix_groups (prefix_id, group_id)
        SELECT ${prefix.id}, id FROM core.groups WHERE key = 'vip'
      `;

      const vipId = await createMember(database, "VIP Prefix Reader", ["members", "vip"]);
      const vip: UserAppSessionContext = {
        memberId: vipId,
        sessionId: "0",
        reauthAt: new Date().toISOString(),
        locale: "en",
        displayName: "VIP Prefix Reader",
      };
      const regular = await memberSession(database, "member-1");
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const ref = await forumHref(database, "2");
        const first = await render(database, ref, vip, { cache, tagVersions: versions });
        const second = await render(database, ref, regular, { cache, tagVersions: versions });
        const warm = await render(database, ref, vip, { cache, tagVersions: versions });

        expect(first.kind).toBe("page");
        expect(second.kind).toBe("page");
        expect(warm.kind).toBe("page");

        if (first.kind !== "page" || second.kind !== "page" || warm.kind !== "page") {
          return;
        }

        expect(first.cache).toBe("miss");
        expect(first.html).toContain('data-prefix-key="vip_only"');
        expect(second.cache).toBe("miss");
        expect(second.variant).not.toBe(first.variant);
        expect(second.html).not.toContain('data-prefix-key="vip_only"');
        expect(warm.cache).toBe("hit");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("prompts for a password and reveals the page once the session is unlocked", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const ref = await forumHref(database, "3");
      const locked = await render(database, ref, member);

      expect(locked.kind).toBe("page");

      if (locked.kind !== "page") {
        return;
      }

      expect(locked.status).toBe(200);
      expect(locked.html).toContain("data-forum-locked");
      expect(locked.html).toContain("data-forum-unlock");
      expect(locked.html).not.toContain("data-forum-content");

      const sessionId = await unlockedSession(database, member.memberId);
      const unlocked = await render(database, ref, { ...member, sessionId });

      if (unlocked.kind !== "page") {
        return;
      }

      expect(unlocked.html).toContain("data-forum-content");
      expect(unlocked.html).not.toContain("data-forum-locked");
    });
  }, 30_000);

  test("lists moderators, hides them when configured, and marks the viewer's own moderation", async () => {
    await withSeededDb(async (database) => {
      const moderatorId = await createMember(database, "Page Moderator", ["members"]);
      await database.sql`
        INSERT INTO core.moderators (forum_id, member_id, powers)
        VALUES (2, ${moderatorId}, ARRAY['edit', 'see_unapproved']::text[])
      `;

      const member = await memberSession(database, "member-1");
      const page = await render(database, await forumHref(database, "2"), member);

      if (page.kind === "page") {
        expect(page.html).toContain("data-moderators");
        expect(page.html).toContain("Page Moderator");
        expect(page.html).not.toContain("data-forum-mod-note");
      }

      const moderatorContext: UserAppSessionContext = {
        memberId: moderatorId,
        sessionId: "0",
        reauthAt: new Date().toISOString(),
        locale: "en",
        displayName: "Page Moderator",
      };
      const moderator = await render(database, await forumHref(database, "2"), moderatorContext);

      if (moderator.kind === "page" && page.kind === "page") {
        expect(moderator.html).toContain("data-forum-mod-note");
        expect(moderator.variant).not.toBe(page.variant);
      }

      await database.sql`UPDATE core.forums SET show_moderators = false WHERE id = 2`;
      const hidden = await render(database, await forumHref(database, "2"), member);

      if (hidden.kind === "page") {
        expect(hidden.html).not.toContain("data-moderators");
      }
    });
  }, 30_000);

  test("returns 404 for a hidden forum and 403 for show without read", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const hidden = await createForum(database, {
        title: "Hidden",
        slug: "hidden",
        parentId: "1",
      });
      await setStandardActions(database, hidden, []);
      const hiddenResult = await render(database, await forumHref(database, hidden), member);

      expect(hiddenResult.kind).toBe("page");

      if (hiddenResult.kind === "page") {
        expect(hiddenResult.status).toBe(404);
        expect(hiddenResult.cache).toBeNull();
      }

      const showOnly = await createForum(database, {
        title: "Show only",
        slug: "show-only",
        parentId: "1",
      });
      await setStandardActions(database, showOnly, ["show"]);
      const showOnlyResult = await render(database, await forumHref(database, showOnly), member);

      if (showOnlyResult.kind === "page") {
        expect(showOnlyResult.status).toBe(403);
      }
    });
  }, 30_000);

  test("registers password-unlock and member-moderator variants without leaks", async () => {
    await withSeededDb(async (database) => {
      const moderatorId = await createMember(database, "Variant Moderator", ["members"]);
      await database.sql`
        INSERT INTO core.moderators (forum_id, member_id, powers)
        VALUES (2, ${moderatorId}, ARRAY['see_unapproved']::text[])
      `;

      const member = await memberSession(database, "member-1");
      const moderator: UserAppSessionContext = {
        memberId: moderatorId,
        sessionId: "0",
        reauthAt: new Date().toISOString(),
        locale: "en",
        displayName: "Variant Moderator",
      };
      const unlockedId = await unlockedSession(database, member.memberId);
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const forum2 = await forumHref(database, "2");
        const forum3 = await forumHref(database, "3");
        const renderVariant = async (ref: string, session: UserAppSessionContext) => {
          const result = await render(database, ref, session, {
            cache,
            tagVersions: versions,
          });

          if (result.kind !== "page") {
            throw new Error("Expected a page");
          }

          return {
            variant: result.variant ?? `status:${result.status}`,
            html: result.html,
            ...(result.cache === null ? {} : { cache: result.cache }),
          };
        };

        const cases: VariantCase[] = [
          {
            name: "member forum 2",
            render: () => renderVariant(forum2, member),
          },
          {
            name: "moderator forum 2",
            render: () => renderVariant(forum2, moderator),
          },
          {
            name: "locked forum 3",
            render: () => renderVariant(forum3, member),
          },
          {
            name: "unlocked forum 3",
            render: () => renderVariant(forum3, { ...member, sessionId: unlockedId }),
          },
        ];

        const report = await assertCacheVariants({
          route: "/forum/[ref]",
          cases,
          cache,
          leaks: [
            {
              description: "moderator-only controls never reach a member",
              markers: ["data-forum-mod-note"],
              absentFrom: ["member forum 2", "locked forum 3"],
            },
            {
              description: "locked content never appears before the unlock",
              markers: ["data-forum-content"],
              absentFrom: ["locked forum 3"],
            },
            {
              description: "the unlock prompt disappears once unlocked",
              markers: ["data-forum-locked"],
              absentFrom: ["unlocked forum 3"],
            },
          ],
        });

        expect(report.variants.size).toBe(4);
        expect(report.variants.get("member forum 2")).not.toBe(
          report.variants.get("moderator forum 2"),
        );
        expect(report.variants.get("locked forum 3")).not.toBe(
          report.variants.get("unlocked forum 3"),
        );
      } finally {
        await versions.close();
      }
    });
  }, 30_000);
});
