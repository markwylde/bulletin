import { describe, expect, test } from "bun:test";
import {
  bumpCacheTags,
  createRenderCache,
  createTagVersions,
  readTagVersions,
} from "@bulletin/cache";
import {
  baseSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { createServerT } from "@bulletin/i18n";
import { assertCacheVariants, type VariantCase } from "@bulletin/test-utils/cache-variants";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { saveBoardSettings } from "../../apps/staff-api/src/board-settings.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { demoContract } from "../../apps/user-app/src/contracts.ts";
import { type DemoRouteInput, renderDemoRoute } from "../../apps/user-app/src/demo/route.ts";
import { etagFor, isNotModified, shellKey } from "../../apps/user-app/src/http/cache.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "demo_variants" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
        flagsSeedModule,
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

async function unlockedSession(database: TestDatabase, memberId: string): Promise<string> {
  const [session] = (await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
    VALUES (${memberId}, 'user', decode(md5(random()::text), 'hex'), now() + interval '1 day')
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (session === undefined) {
    throw new Error("Could not create a session");
  }

  await database.sql`
    INSERT INTO core.session_grants (session_id, kind, resource_id)
    VALUES (${session.id}, 'forum_password', 3)
  `;

  return session.id;
}

async function renderVariant(
  database: TestDatabase,
  cache: ReturnType<typeof createRenderCache>,
  input: {
    readonly session: UserAppSessionContext | null;
    readonly forumId: string;
    readonly pluginsGeneration?: number;
    readonly showDeleted?: boolean;
    readonly tagVersions?: DemoRouteInput["tagVersions"];
  },
) {
  const request: DemoRouteInput = {
    sql: database.sql,
    locale: "en",
    translate,
    session: input.session,
    forumId: input.forumId,
    showDeleted: input.showDeleted ?? false,
    pluginsGeneration: input.pluginsGeneration ?? 1,
    colourScheme: "system",
    cache,
    tagVersions: input.tagVersions,
  };

  const result = await renderDemoRoute(request);

  return {
    variant: result.variant ?? `status:${result.status}`,
    html: result.html,
    ...(result.cache === null ? {} : { cache: result.cache }),
  };
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (check()) {
      return;
    }

    await Bun.sleep(20);
  }

  throw new Error("Timed out waiting for the tag listener");
}

async function forumActions(database: TestDatabase, forumId: string): Promise<number> {
  const [row] = (await database.sql`
    SELECT actions
    FROM core.forum_permissions
    WHERE forum_id = ${forumId}
      AND mask_id = (SELECT id FROM core.masks WHERE key = 'standard')
  `) as Array<{ actions: number }>;

  return row?.actions ?? 0;
}

async function setForumActions(
  database: TestDatabase,
  forumId: string,
  actions: number,
): Promise<void> {
  await database.sql`
    UPDATE core.forum_permissions
    SET actions = ${actions}
    WHERE forum_id = ${forumId}
      AND mask_id = (SELECT id FROM core.masks WHERE key = 'standard')
  `;
}

async function setCompactFlag(database: TestDatabase, value: boolean): Promise<void> {
  await database.sql`
    UPDATE core.feature_flags SET default_value = ${value} WHERE key = 'compactTopicList'
  `;
}

integrationDescribe("demo route cache variants (ADR 0006)", () => {
  test("a guest and a member with the same bits share one variant in either order", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const member = await memberSession(database, "member-1");

        // Guest first, then the member, on one warmed cache.
        const guestFirstCache = createRenderCache({ tags: versions });
        const guestFirst = await renderVariant(database, guestFirstCache, {
          session: null,
          forumId: "2",
        });
        const memberSecond = await renderVariant(database, guestFirstCache, {
          session: member,
          forumId: "2",
        });

        expect(guestFirst.cache).toBe("miss");
        expect(memberSecond.variant).toBe(guestFirst.variant);
        expect(memberSecond.cache).toBe("hit");
        expect(memberSecond.html).toBe(guestFirst.html);
        // The shared fragment never carries visible member-only markup.
        expect(guestFirst.html).toContain("data-overlay-member-only");
        expect(guestFirst.html).toMatch(/data-account-link[^>]*\bhidden\b/);
        expect(guestFirst.html).not.toContain("isMember");

        // Member first, then the guest, on a fresh cache.
        const memberFirstCache = createRenderCache({ tags: versions });
        const memberFirst = await renderVariant(database, memberFirstCache, {
          session: member,
          forumId: "2",
        });
        const guestSecond = await renderVariant(database, memberFirstCache, {
          session: null,
          forumId: "2",
        });

        expect(memberFirst.cache).toBe("miss");
        expect(guestSecond.variant).toBe(memberFirst.variant);
        expect(guestSecond.cache).toBe("hit");
        expect(guestSecond.html).toBe(memberFirst.html);
      } finally {
        await versions.close();
      }
    });
  });

  test("member and guest share the demo fragment but never the ETag", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const base = {
          sql: database.sql,
          locale: "en" as const,
          translate,
          forumId: "2",
          showDeleted: false,
          pluginsGeneration: 1,
          colourScheme: "system" as const,
          cache,
          tagVersions: versions,
        };
        const guest = await renderDemoRoute({ ...base, session: null });
        const member = await renderDemoRoute({
          ...base,
          session: await memberSession(database, "member-1"),
        });

        expect(guest.cache).toBe("miss");
        // The fragment key and HTML stay shared (ADR 0006: cache by visibility, not viewer).
        expect(member.variant).toBe(guest.variant);
        expect(member.cache).toBe("hit");
        expect(member.html).toBe(guest.html);
        // The shell differs (data-visitor, overlay), so the response ETags must differ.
        expect(member.etag).not.toBe(guest.etag);
        expect(isNotModified(guest.etag, member.etag)).toBe(false);
        expect(isNotModified(member.etag, member.etag)).toBe(true);
      } finally {
        await versions.close();
      }
    });
  });

  test("a live template edit invalidates a warmed cache entry and its ETag", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const member = await memberSession(database, "member-1");
        const input = {
          sql: database.sql,
          locale: "en" as const,
          translate,
          session: member,
          forumId: "2",
          showDeleted: false,
          pluginsGeneration: 1,
          colourScheme: "system" as const,
          cache,
          tagVersions: versions,
        };

        const first = await renderDemoRoute(input);
        const warm = await renderDemoRoute(input);

        expect(first.cache).toBe("miss");
        expect(warm.cache).toBe("hit");
        expect(warm.variant).toBe(first.variant);

        await database.sql`
          UPDATE core.theme_templates
          SET body = replace(body, '<main id="main"', '<main data-theme-live-edit id="main"'),
              version = version + 1
          WHERE name = 'demo'
        `;

        // The route reloads the theme per request, so a template edit changes the
        // fingerprint (and thus the variant and ETag) without restarting the process.
        const edited = await renderDemoRoute(input);

        expect(edited.cache).toBe("miss");
        expect(edited.variant).not.toBe(first.variant);
        expect(edited.etag).not.toBe(first.etag);
        expect(edited.html).toContain("data-theme-live-edit");
      } finally {
        await versions.close();
      }
    });
  });

  test("an invalidation during preparation reloads instead of storing stale HTML", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const realCache = createRenderCache({ tags: versions });
        let invalidated = false;
        // A mutation commits while the first attempt's view model is being prepared.
        const racingCache = {
          ...realCache,
          getOrRender: (request: Parameters<typeof realCache.getOrRender>[0]) =>
            realCache.getOrRender({
              ...request,
              prepare: async () => {
                const prepared = await request.prepare();

                if (!invalidated) {
                  invalidated = true;
                  await bumpCacheTags(database.sql, ["forum:2"]);
                  await waitFor(() => versions.version("forum:2") === "1");
                }

                return prepared;
              },
            }),
        };
        const member = await memberSession(database, "member-1");
        const input = {
          sql: database.sql,
          locale: "en" as const,
          translate,
          session: member,
          forumId: "2",
          showDeleted: false,
          pluginsGeneration: 1,
          colourScheme: "system" as const,
          tagVersions: versions,
        };
        const before = await readTagVersions(database.sql, ["forum:2", "board"]);
        const raced = await renderDemoRoute({ ...input, cache: racingCache });

        if (raced.variant === null) {
          throw new Error("expected a cacheable variant");
        }

        // The racing render is retried after the invalidation and stored under the new
        // version, so the ETag describes the content the next request will see.
        expect(raced.cache).toBe("miss");
        const captured = new Map([
          ["forum:2", before.get("forum:2") ?? "0"],
          ["board", before.get("board") ?? "0"],
        ]);
        const bumped = new Map([
          ["forum:2", "1"],
          ["board", captured.get("board") ?? "0"],
        ]);

        const shell = shellKey({ visitor: "member" });

        expect(raced.etag).toBe(etagFor(raced.variant, bumped, shell));
        expect(raced.etag).not.toBe(etagFor(raced.variant, captured, shell));

        // A later request on the same cache hits the retried content.
        await versions.refresh();
        const next = await renderDemoRoute({ ...input, cache: realCache });

        expect(next.cache).toBe("hit");
        expect(next.etag).toBe(raced.etag);
      } finally {
        await versions.close();
      }
    });
  });

  test("a board settings save invalidates a warmed demo page and its ETag", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const member = await memberSession(database, "member-1");
        const base = {
          sql: database.sql,
          locale: "en" as const,
          translate,
          session: member,
          forumId: "2",
          showDeleted: false,
          pluginsGeneration: 1,
          colourScheme: "system" as const,
          cache,
          tagVersions: versions,
        };
        const first = await renderDemoRoute(base);
        const warm = await renderDemoRoute(base);

        expect(first.cache).toBe("miss");
        expect(warm.cache).toBe("hit");
        expect(first.html).toContain("data-board-name>Bulletin<");

        const saved = await saveBoardSettings(database.sql, member.memberId, {
          boardName: "Renamed board",
          boardDescription: "A renamed place",
          defaultLocale: "en",
          offline: false,
          offlineMessage: "",
        });

        expect(saved.ok).toBe(true);

        // The save bumps `board` in its transaction; the demo header/footer depend on it too.
        await versions.refresh();

        const after = await renderDemoRoute(base);

        expect(after.cache).toBe("miss");
        expect(after.html).toContain("data-board-name>Renamed board<");
        expect(after.etag).not.toBe(first.etag);
      } finally {
        await versions.close();
      }
    });
  });

  test("every variant dimension produces a distinct entry with no leaked content", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const member = await memberSession(database, "member-1");
        const moderator = await memberSession(database, "super-mod");
        const unlockedId = await unlockedSession(database, member.memberId);
        const unlocked = { ...member, sessionId: unlockedId };
        let revokedActions = 0;

        const cases: VariantCase[] = [
          {
            name: "member reads forum 2",
            render: () => renderVariant(database, cache, { session: member, forumId: "2" }),
          },
          {
            name: "permission revoked forum 2",
            setup: async () => {
              revokedActions = await forumActions(database, "2");
              await setForumActions(database, "2", 0);
            },
            teardown: async () => {
              await setForumActions(database, "2", revokedActions);
            },
            render: () => renderVariant(database, cache, { session: member, forumId: "2" }),
          },
          {
            name: "locked forum 3",
            render: () => renderVariant(database, cache, { session: member, forumId: "3" }),
          },
          {
            name: "unlocked forum 3",
            render: () => renderVariant(database, cache, { session: unlocked, forumId: "3" }),
          },
          {
            name: "member forum 5",
            render: () => renderVariant(database, cache, { session: member, forumId: "5" }),
          },
          {
            name: "moderator forum 5",
            render: () => renderVariant(database, cache, { session: moderator, forumId: "5" }),
          },
          {
            name: "moderator forum 5 with deleted",
            render: () =>
              renderVariant(database, cache, {
                session: moderator,
                forumId: "5",
                showDeleted: true,
              }),
          },
          {
            name: "compact flag off forum 5",
            setup: async () => {
              await setCompactFlag(database, false);
            },
            teardown: async () => {
              await setCompactFlag(database, true);
            },
            render: () => renderVariant(database, cache, { session: member, forumId: "5" }),
          },
          {
            name: "plugin generation 2 forum 2",
            setup: async () => {
              await database.sql`
                INSERT INTO core.hook_fragments (generation, name, body)
                VALUES (2, 'demo.after.topics', '<p class="bl-hook" data-demo-hook="2">{% t "demo.hook" %}</p>')
              `;
            },
            teardown: async () => {
              await database.sql`DELETE FROM core.hook_fragments WHERE generation = 2`;
            },
            render: () =>
              renderVariant(database, cache, {
                session: member,
                forumId: "2",
                pluginsGeneration: 2,
              }),
          },
        ];

        const report = await assertCacheVariants({
          route: demoContract.route,
          cases,
          cache,
          leaks: [
            {
              description: "topics never appear in a denied or locked variant",
              markers: ["Demo topic 1"],
              absentFrom: ["permission revoked forum 2", "locked forum 3"],
            },
            {
              description: "moderator tools never appear for members",
              markers: ["data-demo-mod-tools"],
              absentFrom: ["member forum 5", "compact flag off forum 5"],
            },
            {
              description: "deleted content never appears without see_deleted",
              markers: ["data-demo-deleted"],
              absentFrom: ["member forum 5", "compact flag off forum 5", "moderator forum 5"],
            },
            {
              description: "an unlocked forum's content never appears while locked",
              markers: ["data-demo-locked"],
              absentFrom: ["unlocked forum 3"],
            },
            {
              description: "the compact flag value is part of the variant",
              markers: ['data-demo-compact="true"'],
              absentFrom: ["compact flag off forum 5"],
            },
            {
              description: "the installed-plugin hook fragment is its own variant",
              markers: ['data-demo-hook="2"'],
              absentFrom: ["member reads forum 2"],
            },
          ],
        });

        expect(report.variants.size).toBe(cases.length);
        // The revoked case really rendered the error page, and the unlocked one the topics.
        expect(report.variants.get("permission revoked forum 2")).not.toBe(
          report.variants.get("member reads forum 2"),
        );
        expect(report.variants.get("unlocked forum 3")).not.toBe(
          report.variants.get("locked forum 3"),
        );
        expect(report.variants.get("moderator forum 5")).not.toBe(
          report.variants.get("member forum 5"),
        );
        expect(report.variants.get("moderator forum 5 with deleted")).not.toBe(
          report.variants.get("moderator forum 5"),
        );

        // Same permission bits share one entry (ADR 0006 scenario "same bits share"), even
        // for a different member with no session id in the key.
        const memberTwo = await memberSession(database, "member-2");
        const shared = await renderVariant(database, cache, { session: memberTwo, forumId: "2" });
        const original = await renderVariant(database, cache, { session: member, forumId: "2" });

        expect(shared.variant).toBe(report.variants.get("member reads forum 2"));
        expect(shared.cache).toBe("hit");
        expect(shared.html).toBe(original.html);
      } finally {
        await versions.close();
      }
    });
  }, 30_000);
});
