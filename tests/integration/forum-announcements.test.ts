import { describe, expect, test } from "bun:test";
import {
  createRenderCache,
  createTagVersions,
  forumAnnouncementsTag,
  GLOBAL_CACHE_TAGS,
  readTagVersion,
  type TagVersionSource,
} from "@bulletin/cache";
import { bumpFlagTag } from "@bulletin/db/flags";
import { bumpAnnouncementTransitions } from "@bulletin/db/jobs";
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
import { createServerT } from "@bulletin/i18n";
import { assertCacheVariants, type VariantCase } from "@bulletin/test-utils/cache-variants";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderForumRoute } from "../../apps/user-app/src/forums/route.ts";
import { renderHomeRoute } from "../../apps/user-app/src/home/route.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });
const TRUSTED: TagVersionSource = { version: () => "0", isTrusted: () => true };

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "forum_announcements" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
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

interface AnnouncementInput {
  readonly title: string;
  readonly body?: string;
  readonly scope?: "global" | "forums";
  readonly startsAt?: Date;
  readonly endsAt?: Date | null;
  readonly forumIds?: readonly string[];
  readonly includeSubforums?: boolean;
  readonly groupKeys?: readonly string[];
}

async function createAnnouncement(
  database: TestDatabase,
  input: AnnouncementInput,
): Promise<string> {
  const startsAt = input.startsAt ?? new Date(Date.now() - 60_000);
  const [announcement] = (await database.sql`
    INSERT INTO core.announcements (title, body, scope, starts_at, ends_at)
    VALUES (
      ${input.title}, ${input.body ?? "Body"}, ${input.scope ?? "global"},
      ${startsAt}, ${input.endsAt ?? null}
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (announcement === undefined) {
    throw new Error("Could not create announcement");
  }

  for (const forumId of input.forumIds ?? []) {
    await database.sql`
      INSERT INTO core.announcement_targets (announcement_id, forum_id, include_subforums)
      VALUES (${announcement.id}, ${forumId}, ${input.includeSubforums ?? true})
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

async function renderForum(
  database: TestDatabase,
  ref: string,
  session: UserAppSessionContext | null,
  options: {
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
    pluginsGeneration: 1,
    colourScheme: "system",
    cache: options.cache ?? createRenderCache({ tags: options.tagVersions ?? TRUSTED }),
    tagVersions: options.tagVersions ?? TRUSTED,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

async function renderIndex(
  database: TestDatabase,
  session: UserAppSessionContext | null,
  options: {
    readonly cache?: ReturnType<typeof createRenderCache>;
    readonly tagVersions?: TagVersionSource;
    readonly now?: Date;
  } = {},
) {
  return renderHomeRoute({
    sql: database.sql,
    locale: "en",
    translate,
    session,
    pluginsGeneration: 1,
    colourScheme: "system",
    cache: options.cache ?? createRenderCache({ tags: options.tagVersions ?? TRUSTED }),
    tagVersions: options.tagVersions ?? TRUSTED,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

integrationDescribe("announcement blocks", () => {
  test("a forum announcement appears only in its forum and group targeting hides it from guests", async () => {
    await withSeededDb(async (database) => {
      await createAnnouncement(database, {
        title: "Board-wide notice",
        scope: "global",
      });
      await createAnnouncement(database, {
        title: "Support notice",
        scope: "forums",
        forumIds: ["2"],
      });
      await createAnnouncement(database, {
        title: "Members notice",
        scope: "forums",
        forumIds: ["2"],
        groupKeys: ["members"],
      });
      const member = await memberSession(database, "member-1");
      const support = await renderForum(database, "/forum/2-announcements", member);
      const general = await renderForum(database, "/forum/4-introductions", member);
      const index = await renderIndex(database, member);

      expect(support.kind).toBe("page");

      if (support.kind === "page") {
        expect(support.html).toContain("Board-wide notice");
        expect(support.html).toContain("Support notice");
        expect(support.html).toContain("Members notice");
      }

      if (general.kind === "page") {
        expect(general.html).toContain("Board-wide notice");
        expect(general.html).not.toContain("Support notice");
        expect(general.html).not.toContain("Members notice");
      }

      expect(index.html).toContain("Board-wide notice");
      expect(index.html).not.toContain("Support notice");
      expect(index.html).not.toContain("Members notice");

      const guest = await renderForum(database, "/forum/2-announcements", null);

      if (guest.kind === "page") {
        expect(guest.html).toContain("Board-wide notice");
        expect(guest.html).not.toContain("Members notice");
      }
    });
  }, 30_000);

  test("a VIP-targeted announcement gets its own variant and never reaches a regular member", async () => {
    await withSeededDb(async (database) => {
      await createAnnouncement(database, {
        title: "VIP-only offer",
        scope: "forums",
        forumIds: ["2"],
        groupKeys: ["vip"],
      });
      const regular = await memberSession(database, "member-1");
      const vipId = await createMember(database, "VIP Reader", ["members", "vip"]);
      const vip: UserAppSessionContext = {
        memberId: vipId,
        sessionId: "0",
        reauthAt: new Date().toISOString(),
        locale: "en",
        displayName: "VIP Reader",
      };
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const renderVariant = async (session: UserAppSessionContext) => {
          const result = await renderForum(database, "/forum/2-announcements", session, {
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
          { name: "regular member", render: () => renderVariant(regular) },
          { name: "vip member", render: () => renderVariant(vip) },
        ];
        const report = await assertCacheVariants({
          route: "/forum/[ref]",
          cases,
          cache,
          leaks: [
            {
              description: "a VIP-targeted announcement never reaches a regular member",
              markers: ["VIP-only offer"],
              absentFrom: ["regular member"],
            },
          ],
        });

        expect(report.variants.get("regular member")).not.toBe(report.variants.get("vip member"));
        expect((await renderVariant(vip)).html).toContain("VIP-only offer");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("a cached page expires at the announcement's end and the worker bumps the block tags", async () => {
    await withSeededDb(async (database) => {
      const base = Date.now();
      const startsAt = new Date(base - 60_000);
      const endsAt = new Date(base + 5_000);
      await createAnnouncement(database, {
        title: "Temporary notice",
        scope: "global",
        startsAt,
        endsAt,
      });
      await createAnnouncement(database, {
        title: "Forum temporary notice",
        scope: "forums",
        forumIds: ["1"],
        includeSubforums: true,
        startsAt: new Date(base - 120_000),
        endsAt: new Date(base - 1_000),
      });

      let now = base;
      const cache = createRenderCache({ tags: TRUSTED, now: () => now });
      const member = await memberSession(database, "member-1");
      const first = await renderForum(database, "/forum/2-announcements", member, {
        cache,
        now: new Date(base),
      });

      expect(first.kind).toBe("page");

      if (first.kind !== "page") {
        return;
      }

      expect(first.cache).toBe("miss");
      expect(first.html).toContain("Temporary notice");

      const warm = await renderForum(database, "/forum/2-announcements", member, {
        cache,
        now: new Date(base),
      });
      expect(warm.kind === "page" ? warm.cache : null).toBe("hit");

      now = base + 6_000;
      const expired = await renderForum(database, "/forum/2-announcements", member, {
        cache,
        now: new Date(now),
      });

      if (expired.kind === "page") {
        expect(expired.cache).toBe("miss");
        expect(expired.html).not.toContain("Temporary notice");
      }

      // The minute worker bumps the global tag and every subtree tag of a forum-targeted
      // transition, without staff action.
      const beforeGlobal = await readTagVersion(database.sql, GLOBAL_CACHE_TAGS.announcements);
      const beforeForum = await readTagVersion(database.sql, forumAnnouncementsTag("2"));
      const tags = await bumpAnnouncementTransitions(database.sql, new Date(now));

      expect(tags).toContain(GLOBAL_CACHE_TAGS.announcements);
      expect(tags).toContain(forumAnnouncementsTag("1"));
      expect(tags).toContain(forumAnnouncementsTag("2"));
      expect(await readTagVersion(database.sql, GLOBAL_CACHE_TAGS.announcements)).not.toBe(
        beforeGlobal,
      );
      expect(await readTagVersion(database.sql, forumAnnouncementsTag("2"))).not.toBe(beforeForum);
    });
  }, 30_000);

  test("hides announcement blocks when the flag is off and changes the cache variant", async () => {
    await withSeededDb(async (database) => {
      await createAnnouncement(database, { title: "Flagged notice", scope: "global" });
      const member = await memberSession(database, "member-1");
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      async function setFlag(value: boolean): Promise<void> {
        await database.sql`
          UPDATE core.feature_flags SET default_value = ${value} WHERE key = 'announcements'
        `;
        await bumpFlagTag(database.sql);
        await versions.refresh();
      }

      try {
        const cache = createRenderCache({ tags: versions });
        const indexOn = await renderIndex(database, member, { cache, tagVersions: versions });
        expect(indexOn.html).toContain("Flagged notice");
        const on = await renderForum(database, "/forum/2-announcements", member, {
          cache,
          tagVersions: versions,
        });

        expect(on.kind).toBe("page");

        if (on.kind !== "page") {
          return;
        }

        expect(on.cache).toBe("miss");
        expect(on.html).toContain("Flagged notice");

        await setFlag(false);

        const indexOff = await renderIndex(database, member, { cache, tagVersions: versions });
        expect(indexOff.html).not.toContain("Flagged notice");
        const off = await renderForum(database, "/forum/2-announcements", member, {
          cache,
          tagVersions: versions,
        });

        if (off.kind !== "page") {
          return;
        }

        expect(off.cache).toBe("miss");
        expect(off.variant).not.toBe(on.variant);
        expect(off.html).not.toContain("Flagged notice");

        await setFlag(true);

        const back = await renderForum(database, "/forum/2-announcements", member, {
          cache,
          tagVersions: versions,
        });

        expect(back.kind).toBe("page");

        if (back.kind === "page") {
          expect(back.variant).toBe(on.variant);
          expect(back.html).toContain("Flagged notice");
        }
      } finally {
        await versions.close();
      }
    });
  }, 30_000);
});
