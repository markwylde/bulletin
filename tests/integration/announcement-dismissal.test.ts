import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { displayNameSkeleton } from "@bulletin/domain/member";
import {
  dismissAnnouncement,
  type ForumAction,
  forumActionMask,
} from "@bulletin/domain/permissions";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { announceDismissResponse } from "../../apps/user-api/src/announcements.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "announcement_dismissal" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        membersSeedModule,
        flagsSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
}

async function memberId(database: TestDatabase, sub: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT member_id::text AS id FROM pii.identities WHERE sub = ${sub}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing member ${sub}`);
  }

  return row.id;
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
      FROM core.groups g WHERE g.key = ${key}
    `;
  }

  return member.id;
}

async function createAnnouncement(
  database: TestDatabase,
  input: {
    readonly title: string;
    readonly forumId?: string;
    readonly groupKeys?: readonly string[];
  },
): Promise<string> {
  const [announcement] = (await database.sql`
    INSERT INTO core.announcements (title, body, scope, starts_at, dismissible)
    VALUES (
      ${input.title}, 'Body', ${input.forumId === undefined ? "global" : "forums"},
      now() - interval '1 minute', true
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (announcement === undefined) {
    throw new Error("Could not create announcement");
  }

  if (input.forumId !== undefined) {
    await database.sql`
      INSERT INTO core.announcement_targets (announcement_id, forum_id)
      VALUES (${announcement.id}, ${input.forumId})
    `;
  }

  for (const key of input.groupKeys ?? []) {
    await database.sql`
      INSERT INTO core.announcement_groups (announcement_id, group_id)
      SELECT ${announcement.id}, id FROM core.groups WHERE key = ${key}
    `;
  }

  return announcement.id;
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

integrationDescribe("announcement dismissal permissions", () => {
  test("a group-targeted notice cannot be dismissed by a non-member", async () => {
    await withSeededDb(async (database) => {
      const regular = await memberId(database, "member-1");
      const vip = await createMember(database, "VIP Dismisser", ["members", "vip"]);
      const announcement = await createAnnouncement(database, {
        title: "VIP dismissal",
        forumId: "2",
        groupKeys: ["vip"],
      });

      expect(await dismissAnnouncement(database.sql, regular, announcement)).toBe("not_found");
      expect(await dismissAnnouncement(database.sql, vip, announcement)).toBe("ok");
    });
  }, 30_000);

  test("a notice targeting a hidden forum cannot be dismissed", async () => {
    await withSeededDb(async (database) => {
      const [hidden] = (await database.sql`
        INSERT INTO core.forums (parent_id, title, slug)
        VALUES (1, 'Hidden dismissal forum', 'hidden-dismissal-forum')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (hidden === undefined) {
        throw new Error("Could not create hidden forum");
      }

      await setStandardActions(database, hidden.id, []);
      const member = await memberId(database, "member-1");
      const announcement = await createAnnouncement(database, {
        title: "Hidden forum notice",
        forumId: hidden.id,
      });

      expect(await dismissAnnouncement(database.sql, member, announcement)).toBe("not_found");

      const rows = (await database.sql`
        SELECT 1 FROM core.announcement_dismissals WHERE announcement_id = ${announcement}
      `) as unknown[];
      expect(rows).toHaveLength(0);
    });
  }, 30_000);

  test("the dismissal endpoint is off when the announcements flag is off", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const announcement = await createAnnouncement(database, { title: "Flag-off dismissal" });

      await database.sql`
        UPDATE core.feature_flags SET default_value = false WHERE key = 'announcements'
      `;

      const disabled = await announceDismissResponse(database.sql, member, announcement);

      expect(disabled.status).toBe(404);
      const empty = (await database.sql`
        SELECT 1 FROM core.announcement_dismissals WHERE announcement_id = ${announcement}
      `) as unknown[];
      expect(empty).toHaveLength(0);

      await database.sql`
        UPDATE core.feature_flags SET default_value = true WHERE key = 'announcements'
      `;

      const enabled = await announceDismissResponse(database.sql, member, announcement);
      expect(enabled.status).toBe(200);
    });
  }, 30_000);
});
