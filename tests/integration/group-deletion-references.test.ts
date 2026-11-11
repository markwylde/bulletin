import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  forumSeedModule,
  groupsSeedModule,
  membersSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { displayNameSkeleton } from "@bulletin/domain/member";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { deleteGroup } from "../../apps/staff-api/src/groups.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderForumRoute } from "../../apps/user-app/src/forums/route.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });
const ANNOUNCEMENT_TITLE = "Restricted audience notice";
const PREFIX_LABEL = "Restricted Label";

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "group_delete_refs" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        forumSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        flagsSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
}

async function expectRejection(query: () => PromiseLike<unknown>, pattern?: string): Promise<void> {
  try {
    await query();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (pattern !== undefined) {
      expect(message).toContain(pattern);
    }

    return;
  }

  throw new Error("Expected the statement to be rejected");
}

async function forumRef(database: TestDatabase, slug: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id, slug FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string; slug: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${slug}`);
  }

  return `/forum/${row.id}-${row.slug}`;
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
  groups: readonly string[],
): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES (${name}, ${displayNameSkeleton(name)})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error(`Could not create ${name}`);
  }

  for (const [index, key] of groups.entries()) {
    await database.sql`
      INSERT INTO core.member_groups (member_id, group_id, is_primary)
      SELECT ${member.id}, g.id, ${index === 0}
      FROM core.groups g
      WHERE g.key = ${key}
    `;
  }

  return member.id;
}

async function createGroup(database: TestDatabase): Promise<string> {
  const [group] = (await database.sql`
    INSERT INTO core.groups (key, title, display_order)
    VALUES ('restricted_audience', 'Restricted audience', 100)
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (group === undefined) {
    throw new Error("Could not create the restricted group");
  }

  return group.id;
}

async function restrictAudience(
  database: TestDatabase,
  forumId: string,
  groupId: string,
): Promise<void> {
  const [announcement] = (await database.sql`
    INSERT INTO core.announcements (title, body, scope, starts_at)
    VALUES (
      ${ANNOUNCEMENT_TITLE}, 'Visible to the restricted audience only.', 'forums',
      now() - interval '1 minute'
    )
    RETURNING id
  `) as Array<{ id: string }>;

  if (announcement === undefined) {
    throw new Error("Could not create the announcement");
  }

  await database.sql`
    INSERT INTO core.announcement_targets (announcement_id, forum_id, include_subforums)
    VALUES (${announcement.id}, ${forumId}, false)
  `;
  await database.sql`
    INSERT INTO core.announcement_groups (announcement_id, group_id)
    VALUES (${announcement.id}, ${groupId})
  `;

  const [prefix] = (await database.sql`
    INSERT INTO core.prefixes (key, colour, display_order)
    VALUES ('restricted_label', '#0f766e', 99)
    RETURNING id
  `) as Array<{ id: string }>;

  if (prefix === undefined) {
    throw new Error("Could not create the prefix");
  }

  await database.sql`
    INSERT INTO core.prefix_labels (prefix_id, locale, label)
    VALUES (${prefix.id}, 'en', ${PREFIX_LABEL})
  `;
  await database.sql`
    INSERT INTO core.prefix_groups (prefix_id, group_id)
    VALUES (${prefix.id}, ${groupId})
  `;
  await database.sql`
    INSERT INTO core.forum_prefixes (forum_id, prefix_id, position)
    VALUES (${forumId}, ${prefix.id}, 99)
  `;
}

integrationDescribe("group deletion with audience references", () => {
  test("keeps the last announcement and prefix audience when its group is deleted", async () => {
    await withSeededDb(async (database) => {
      const forumRefValue = await forumRef(database, "help-questions");
      const [forum] = (await database.sql`
        SELECT id::text AS id FROM core.forums WHERE slug = 'help-questions'
      `) as Array<{ id: string }>;

      if (forum === undefined) {
        throw new Error("Missing help-questions forum");
      }

      const groupId = await createGroup(database);
      await restrictAudience(database, forum.id, groupId);

      const admin = await memberSession(database, "admin");
      const regular = await memberSession(database, "member-1");
      const targeted: UserAppSessionContext = {
        memberId: await createMember(database, "Restricted Reader", [
          "members",
          "restricted_audience",
        ]),
        sessionId: "0",
        reauthAt: new Date().toISOString(),
        locale: "en",
        displayName: "Restricted Reader",
      };
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });
      const cache = createRenderCache({ tags: versions });

      try {
        const render = (session: UserAppSessionContext | null, renderCache = cache) =>
          renderForumRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session,
            ref: forumRefValue,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache: renderCache,
            tagVersions: versions,
          });

        const assertHidden = async (
          session: UserAppSessionContext | null,
          expectedCache: "miss" | "hit",
        ): Promise<void> => {
          const result = await render(session);
          expect(result.kind).toBe("page");

          if (result.kind !== "page") {
            return;
          }

          expect(result.cache).toBe(expectedCache);
          expect(result.html).not.toContain(ANNOUNCEMENT_TITLE);
          expect(result.html).not.toContain(PREFIX_LABEL);
        };

        await assertHidden(null, "miss");
        await assertHidden(null, "hit");
        await assertHidden(regular, "miss");
        await assertHidden(regular, "hit");

        const targetedFirst = await render(targeted);
        expect(targetedFirst.kind).toBe("page");

        if (targetedFirst.kind === "page") {
          expect(targetedFirst.cache).toBe("miss");
          expect(targetedFirst.html).toContain(ANNOUNCEMENT_TITLE);
          expect(targetedFirst.html).toContain(PREFIX_LABEL);
        }

        const targetedWarm = await render(targeted);
        expect(targetedWarm.kind === "page" ? targetedWarm.cache : null).toBe("hit");

        if (targetedWarm.kind === "page") {
          expect(targetedWarm.html).toContain(ANNOUNCEMENT_TITLE);
          expect(targetedWarm.html).toContain(PREFIX_LABEL);
        }

        const result = await deleteGroup(database.sql, admin.memberId, { id: groupId });

        expect(result).toEqual({ ok: false, code: "group_in_use" });

        // Warm fragments still deny, and a cold fragment sees that the audience rows survived.
        await assertHidden(null, "hit");
        await assertHidden(regular, "hit");

        const coldCache = createRenderCache({ tags: versions });
        const coldGuest = await render(null, coldCache);
        const coldMember = await render(regular, coldCache);
        const coldTargeted = await render(targeted, coldCache);

        expect(coldGuest.kind).toBe("page");
        expect(coldMember.kind).toBe("page");
        expect(coldTargeted.kind).toBe("page");

        if (coldGuest.kind === "page") {
          expect(coldGuest.html).not.toContain(ANNOUNCEMENT_TITLE);
          expect(coldGuest.html).not.toContain(PREFIX_LABEL);
        }

        if (coldMember.kind === "page") {
          expect(coldMember.html).not.toContain(ANNOUNCEMENT_TITLE);
          expect(coldMember.html).not.toContain(PREFIX_LABEL);
        }

        if (coldTargeted.kind === "page") {
          expect(coldTargeted.html).toContain(ANNOUNCEMENT_TITLE);
          expect(coldTargeted.html).toContain(PREFIX_LABEL);
        }

        const [remaining] = (await database.sql`
          SELECT
            EXISTS (SELECT 1 FROM core.groups WHERE id = ${groupId}) AS group_exists,
            EXISTS (
              SELECT 1 FROM core.announcement_groups WHERE group_id = ${groupId}
            ) AS announcement_audience,
            EXISTS (
              SELECT 1 FROM core.prefix_groups WHERE group_id = ${groupId}
            ) AS prefix_restriction
        `) as Array<{
          group_exists: boolean;
          announcement_audience: boolean;
          prefix_restriction: boolean;
        }>;
        expect(remaining).toEqual({
          group_exists: true,
          announcement_audience: true,
          prefix_restriction: true,
        });

        // Direct SQL cannot bypass the rule either: the restricting foreign keys fail.
        await expectRejection(
          () => database.sql`DELETE FROM core.groups WHERE id = ${groupId}`,
          "foreign key",
        );
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("refuses to delete a group referenced by a profile-field visibility rule", async () => {
    await withSeededDb(async (database) => {
      const admin = await createMember(database, "Field Group Admin", ["administrators"]);
      const [group] = (await database.sql`
        INSERT INTO core.groups (key, title, display_order)
        VALUES ('field_visibility_group', 'Field visibility', 120)
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const [field] = (await database.sql`
        INSERT INTO core.profile_fields (type, labels)
        VALUES ('short_text', '{"en":"Secret","es":"Secreto","fr":"Secret"}'::jsonb)
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (group === undefined || field === undefined) {
        throw new Error("Could not create the field visibility fixture");
      }

      await database.sql`
        INSERT INTO core.profile_field_groups (field_id, group_id, can_view, can_edit)
        VALUES (${field.id}, ${group.id}, true, false)
      `;

      expect(await deleteGroup(database.sql, admin, { id: group.id })).toEqual({
        ok: false,
        code: "group_in_use",
      });
      await expectRejection(
        () => database.sql`DELETE FROM core.groups WHERE id = ${group.id}`,
        "profile_field_groups_group_id_fkey",
      );
    });
  }, 30_000);
});
