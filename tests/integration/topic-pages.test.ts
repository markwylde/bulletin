import { describe, expect, test } from "bun:test";
import {
  bumpCacheTags,
  createRenderCache,
  createTagVersions,
  GLOBAL_CACHE_TAGS,
} from "@bulletin/cache";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { editPost, pin, reply, restore, softDelete, startTopic } from "@bulletin/domain/topics";
import { createServerT } from "@bulletin/i18n";
import { assertCacheVariants, type VariantCase } from "@bulletin/test-utils/cache-variants";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderForumRoute } from "../../apps/user-app/src/forums/route.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "topic_pages" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
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
    throw new Error(`Missing seeded member ${sub}`);
  }

  return {
    memberId: row.member_id,
    sessionId: "0",
    reauthAt: new Date().toISOString(),
    locale: "en",
    displayName: row.display_name,
  };
}

async function forumId(database: TestDatabase, slug: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${slug}`);
  }

  return row.id;
}

function expectOk<T>(
  outcome:
    | { readonly ok: true; readonly result: T }
    | { readonly ok: false; readonly code: string },
): T {
  if (!outcome.ok) {
    throw new Error(`Expected success, received ${outcome.code}`);
  }

  return outcome.result;
}

async function topicCache(
  database: TestDatabase,
  session: UserAppSessionContext | null,
  ref: string,
  cache: ReturnType<typeof createRenderCache>,
  versions: Awaited<ReturnType<typeof createTagVersions>>,
) {
  return renderTopicRoute({
    sql: database.sql,
    locale: "en",
    translate,
    session,
    ref,
    pluginsGeneration: 1,
    colourScheme: "system",
    cache,
    tagVersions: versions,
  });
}

integrationDescribe("forum topic list and topic view", () => {
  test("lists pinned topics first, paginates and filters by prefix", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const help = await forumId(database, "help-questions");
      const member = await memberSession(database, "member-1");
      const moderator = await memberSession(database, "super-mod");

      const older = expectOk(
        await startTopic(database.sql, {
          actorId: member.memberId,
          forumId: offTopic,
          title: "Older unpinned topic",
          bodyMd: "Older body.",
        }),
      );
      const newer = expectOk(
        await startTopic(database.sql, {
          actorId: member.memberId,
          forumId: offTopic,
          title: "Newer unpinned topic",
          bodyMd: "Newer body.",
        }),
      );

      await database.sql`
        UPDATE core.topics
        SET last_post_at = now() - interval '2 hours'
        WHERE id = ${older.topicId}
      `;
      await database.sql`
        UPDATE core.topics SET last_post_at = now() - interval '1 hour' WHERE id = ${newer.topicId}
      `;

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });

        const unpinned = await renderForumRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          ref: `${offTopic}-off-topic`,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });

        expect(unpinned.kind).toBe("page");
        const unpinnedHtml = unpinned.kind === "page" ? unpinned.html : "";
        expect(unpinnedHtml.indexOf(`data-topic-row="${newer.topicId}"`)).toBeLessThan(
          unpinnedHtml.indexOf(`data-topic-row="${older.topicId}"`),
        );

        expectOk(
          await pin(database.sql, {
            actorId: moderator.memberId,
            topicId: older.topicId,
            pinned: true,
          }),
        );
        await versions.refresh();

        const pinned = await renderForumRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          ref: `${offTopic}-off-topic`,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        const pinnedHtml = pinned.kind === "page" ? pinned.html : "";
        expect(pinnedHtml.indexOf(`data-topic-row="${older.topicId}"`)).toBeLessThan(
          pinnedHtml.indexOf(`data-topic-row="${newer.topicId}"`),
        );

        await database.sql`UPDATE core.board_settings SET topics_per_page = 1 WHERE id = 1`;
        await versions.refresh();
        const pageTwo = await renderForumRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          ref: `${offTopic}-off-topic`,
          page: 2,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        const pageTwoHtml = pageTwo.kind === "page" ? pageTwo.html : "";
        expect(pageTwoHtml).toContain('data-topic-page="2"');
        expect(pageTwoHtml.match(/data-topic-row=/g)?.length).toBe(1);

        const prefixRows = (await database.sql`
          SELECT p.key, p.id::text AS id
          FROM core.forums f
          JOIN core.forum_prefixes fp ON fp.forum_id = f.id
          JOIN core.prefixes p ON p.id = fp.prefix_id
          WHERE f.slug = 'help-questions'
          ORDER BY p.key
        `) as Array<{ key: string; id: string }>;
        const bugPrefix = prefixRows.find((row) => row.key === "bug")?.id;
        const questionPrefix = prefixRows.find((row) => row.key === "question")?.id;

        if (bugPrefix === undefined || questionPrefix === undefined) {
          throw new Error("Missing seeded help prefixes");
        }

        expectOk(
          await startTopic(database.sql, {
            actorId: member.memberId,
            forumId: help,
            title: "Bug report about the editor",
            bodyMd: "The bug body.",
            prefixId: bugPrefix,
          }),
        );
        expectOk(
          await startTopic(database.sql, {
            actorId: member.memberId,
            forumId: help,
            title: "Question about the editor",
            bodyMd: "The question body.",
            prefixId: questionPrefix,
          }),
        );

        const filtered = await renderForumRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          ref: `${help}-help-questions`,
          prefix: "bug",
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        const filteredHtml = filtered.kind === "page" ? filtered.html : "";
        expect(filteredHtml).toContain("Bug report about the editor");
        expect(filteredHtml).not.toContain("Question about the editor");

        expectOk(
          await startTopic(database.sql, {
            actorId: member.memberId,
            forumId: help,
            title: "Second bug report",
            bodyMd: "Another bug body.",
            prefixId: bugPrefix,
          }),
        );
        await versions.refresh();
        const filteredPages = await renderForumRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          ref: `${help}-help-questions`,
          prefix: "bug",
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        const filteredPagesHtml = filteredPages.kind === "page" ? filteredPages.html : "";
        const nextHref = /href="([^"]+)" rel="next" data-page-next/.exec(filteredPagesHtml)?.[1];
        expect(nextHref).toBeDefined();
        expect(nextHref).toContain("prefix=bug");
        expect(nextHref).toContain("page=2");

        const filteredPageTwo = await renderForumRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          ref: `${help}-help-questions`,
          prefix: "bug",
          page: 2,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        const filteredPageTwoHtml = filteredPageTwo.kind === "page" ? filteredPageTwo.html : "";
        expect(filteredPageTwoHtml).toContain("Bug report about the editor");
        expect(filteredPageTwoHtml).not.toContain("Question about the editor");

        const denied = await renderForumRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: member,
          ref: `${await forumId(database, "staff-room")}-staff-room`,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        expect(denied.kind).toBe("page");
        expect(denied.kind === "page" ? denied.status : 0).toBe(404);
      } finally {
        await versions.close();
      }
    });
  }, 45_000);

  test("renders posts in order, pages them and applies the cache variant harness to quote visibility", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const staff = await forumId(database, "staff-room");
      const guest = null;
      const member = await memberSession(database, "member-1");
      const moderator = await memberSession(database, "super-mod");

      const source = expectOk(
        await startTopic(database.sql, {
          actorId: moderator.memberId,
          forumId: staff,
          title: "Staff-only source",
          bodyMd: "TOP-SECRET-SOURCE-TEXT",
        }),
      );
      const target = expectOk(
        await startTopic(database.sql, {
          actorId: moderator.memberId,
          forumId: offTopic,
          title: "Topic with a staff quote",
          bodyMd: `:::quote{source="post:${source.postId}"}\nquoted\n:::\n\nVisible reply.`,
        }),
      );

      for (const body of ["Second post.", "Third post.", "Fourth post."]) {
        expectOk(
          await reply(database.sql, {
            actorId: member.memberId,
            topicId: target.topicId,
            bodyMd: body,
          }),
        );
      }

      await database.sql`UPDATE core.board_settings SET posts_per_page = 2 WHERE id = 1`;
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const pageTwo = await topicCache(
          database,
          guest,
          `${target.topicId}-topic-with-a-staff-quote/page/2`,
          cache,
          versions,
        );
        expect(pageTwo.kind).toBe("page");
        const pageTwoHtml = pageTwo.kind === "page" ? pageTwo.html : "";
        const postRows = (await database.sql`
          SELECT id::text AS id FROM core.posts WHERE topic_id = ${target.topicId} ORDER BY position
        `) as Array<{ id: string }>;
        expect(pageTwoHtml).toContain(`data-post="${postRows[2]?.id ?? ""}"`);
        expect(pageTwoHtml).toContain(`data-post="${postRows[3]?.id ?? ""}"`);
        expect(pageTwoHtml).toContain("Third post.");
        expect(pageTwoHtml).toContain("Fourth post.");

        const cases: VariantCase[] = [
          {
            name: "guest",
            render: async () => {
              const result = await topicCache(
                database,
                guest,
                `${target.topicId}-topic-with-a-staff-quote`,
                cache,
                versions,
              );
              if (result.kind !== "page") {
                throw new Error("Expected a topic page");
              }
              return {
                variant: result.variant ?? "",
                html: result.html,
                ...(result.cache === null ? {} : { cache: result.cache }),
              };
            },
          },
          {
            name: "member",
            render: async () => {
              const result = await topicCache(
                database,
                member,
                `${target.topicId}-topic-with-a-staff-quote`,
                cache,
                versions,
              );
              if (result.kind !== "page") {
                throw new Error("Expected a topic page");
              }
              return {
                variant: result.variant ?? "",
                html: result.html,
                ...(result.cache === null ? {} : { cache: result.cache }),
              };
            },
          },
          {
            name: "moderator",
            render: async () => {
              const result = await topicCache(
                database,
                moderator,
                `${target.topicId}-topic-with-a-staff-quote`,
                cache,
                versions,
              );
              if (result.kind !== "page") {
                throw new Error("Expected a topic page");
              }
              return {
                variant: result.variant ?? "",
                html: result.html,
                ...(result.cache === null ? {} : { cache: result.cache }),
              };
            },
          },
        ];

        await assertCacheVariants({
          route: "/topic/[ref]",
          cases,
          cache,
          leaks: [
            {
              description: "staff quote",
              markers: ["TOP-SECRET-SOURCE-TEXT"],
              absentFrom: ["guest", "member"],
            },
          ],
        });
      } finally {
        await versions.close();
      }
    });
  }, 45_000);

  test("editing one post preserves the other post-block cache entries", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberSession(database, "member-1");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author.memberId,
          forumId: offTopic,
          title: "Post block caching",
          bodyMd: "First block.",
        }),
      );
      const second = expectOk(
        await reply(database.sql, {
          actorId: author.memberId,
          topicId: topic.topicId,
          bodyMd: "Second block.",
        }),
      );
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const base = createRenderCache({ tags: versions });
        const calls: Array<{ readonly key: string; readonly status: string }> = [];
        const counted = {
          ...base,
          getOrRender: async (request: Parameters<typeof base.getOrRender>[0]) => {
            const result = await base.getOrRender(request);
            calls.push({ key: result.key, status: result.status });
            return result;
          },
        };
        const render = () =>
          topicCache(database, null, `${topic.topicId}-post-block-caching`, counted, versions);

        await render();
        expect(
          calls.some(
            (call) => call.key.startsWith(`post-block:${topic.postId}:`) && call.status === "miss",
          ),
        ).toBe(true);
        expect(
          calls.some(
            (call) => call.key.startsWith(`post-block:${second.postId}:`) && call.status === "miss",
          ),
        ).toBe(true);

        calls.length = 0;
        expectOk(
          await editPost(database.sql, {
            actorId: author.memberId,
            postId: second.postId,
            bodyMd: "Second block edited.",
          }),
        );
        await versions.refresh();
        await render();

        const firstBlock = calls.find((call) => call.key.startsWith(`post-block:${topic.postId}:`));
        const editedBlock = calls.find((call) =>
          call.key.startsWith(`post-block:${second.postId}:`),
        );
        expect(firstBlock?.status).toBe("hit");
        expect(editedBlock?.status).toBe("miss");
      } finally {
        await versions.close();
      }
    });
  }, 45_000);

  test("delete and restore invalidate the affected post block", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberSession(database, "member-1");
      const moderator = await memberSession(database, "super-mod");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author.memberId,
          forumId: offTopic,
          title: "Delete cache topic",
          bodyMd: "First block.",
        }),
      );
      const second = expectOk(
        await reply(database.sql, {
          actorId: author.memberId,
          topicId: topic.topicId,
          bodyMd: "Second block.",
        }),
      );
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const base = createRenderCache({ tags: versions });
        const calls: Array<{ readonly key: string; readonly status: string }> = [];
        const counted = {
          ...base,
          getOrRender: async (request: Parameters<typeof base.getOrRender>[0]) => {
            const result = await base.getOrRender(request);
            calls.push({ key: result.key, status: result.status });
            return result;
          },
        };
        const render = () =>
          topicCache(database, moderator, `${topic.topicId}-delete-cache-topic`, counted, versions);

        await render();
        calls.length = 0;
        expectOk(
          await softDelete(database.sql, {
            actorId: moderator.memberId,
            postId: second.postId,
          }),
        );
        await versions.refresh();
        const deleted = await render();
        const deletedHtml = deleted.kind === "page" ? deleted.html : "";
        expect(
          calls.find((call) => call.key.startsWith(`post-block:${second.postId}:`))?.status,
        ).toBe("miss");
        expect(deletedHtml).toContain("data-post-deleted");
        expect(deletedHtml).toContain('data-post-action="restore"');

        calls.length = 0;
        expectOk(
          await restore(database.sql, {
            actorId: moderator.memberId,
            postId: second.postId,
          }),
        );
        await versions.refresh();
        const restored = await render();
        expect(
          calls.find((call) => call.key.startsWith(`post-block:${second.postId}:`))?.status,
        ).toBe("miss");
        expect(restored.kind === "page" ? restored.html : "").not.toContain("data-post-deleted");
      } finally {
        await versions.close();
      }
    });
  }, 45_000);

  test("moderators with the same visibility share identical edit-form HTML", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberSession(database, "super-mod");
      const otherModerator = await memberSession(database, "admin");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author.memberId,
          forumId: offTopic,
          title: "Shared moderator form",
          bodyMd: "Body.",
        }),
      );
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const render = (session: UserAppSessionContext) =>
          topicCache(database, session, `${topic.topicId}-shared-moderator-form`, cache, versions);

        const authorPage = await render(author);
        const otherPage = await render(otherModerator);
        const authorHtml = authorPage.kind === "page" ? authorPage.html : "";
        const otherHtml = otherPage.kind === "page" ? otherPage.html : "";

        expect(authorHtml).toContain("data-post-edit");
        expect(authorHtml).not.toContain('name="redact"');
        expect(otherHtml).toBe(authorHtml);
      } finally {
        await versions.close();
      }
    });
  }, 45_000);

  test("a lock-only moderator gets Unlock and a pin-only moderator gets Unpin", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberSession(database, "member-1");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author.memberId,
          forumId: offTopic,
          title: "Stateful moderator tools",
          bodyMd: "Body.",
        }),
      );
      const render = async () => {
        const versions = await createTagVersions({
          sql: database.sql,
          heartbeatMs: 100,
          heartbeatTimeoutMs: 1_000,
        });

        try {
          return await topicCache(
            database,
            author,
            `${topic.topicId}-stateful-moderator-tools`,
            createRenderCache({ tags: versions }),
            versions,
          );
        } finally {
          await versions.close();
        }
      };

      // Lock-only: the topic is locked, so Unlock must appear even though Pin is unavailable.
      await database.sql`
        INSERT INTO core.moderators (forum_id, member_id, powers)
        VALUES (${offTopic}, ${author.memberId}, ARRAY['lock']::text[])
      `;
      await database.sql`UPDATE core.topics SET locked = true WHERE id = ${topic.topicId}`;

      const lockOnly = await render();
      const lockHtml = lockOnly.kind === "page" ? lockOnly.html : "";
      expect(lockHtml).toContain('data-topic-tool="unlock"');
      expect(lockHtml).not.toContain('data-topic-tool="pin"');
      expect(lockHtml).not.toContain("data-bulk-post-check");

      // Pin-only: the topic is pinned, so Unpin must appear even though Lock is unavailable.
      await database.sql`
        UPDATE core.moderators SET powers = ARRAY['pin']::text[]
        WHERE forum_id = ${offTopic} AND member_id = ${author.memberId}
      `;
      await database.sql`
        UPDATE core.topics SET locked = false, pinned = true WHERE id = ${topic.topicId}
      `;

      const pinOnly = await render();
      const pinHtml = pinOnly.kind === "page" ? pinOnly.html : "";
      expect(pinHtml).toContain('data-topic-tool="unpin"');
      expect(pinHtml).not.toContain('data-topic-tool="lock"');
      expect(pinHtml).not.toContain("data-bulk-post-check");

      // Split-only: selecting posts is the only way to split, so every post gets a checkbox.
      await database.sql`
        UPDATE core.moderators SET powers = ARRAY['split']::text[]
        WHERE forum_id = ${offTopic} AND member_id = ${author.memberId}
      `;

      const splitOnly = await render();
      const splitHtml = splitOnly.kind === "page" ? splitOnly.html : "";
      expect(splitHtml).toContain("data-bulk-post-check");
      expect(splitHtml).not.toContain('data-bulk-post-action="soft_delete"');
    });
  }, 45_000);

  test("a redaction committed while the page renders never caches the old body", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberSession(database, "member-1");
      const moderator = await memberSession(database, "super-mod");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author.memberId,
          forumId: offTopic,
          title: "Interleaved redaction",
          bodyMd: "Original secret body.",
        }),
      );
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const base = createRenderCache({ tags: versions });
        let calls = 0;
        const cache = {
          ...base,
          getOrRender: async (request: Parameters<typeof base.getOrRender>[0]) => {
            calls += 1;

            // The page has prepared (and holds the old post); redact before the block
            // snapshot is taken, which is exactly the interleaving that used to cache it.
            if (calls === 2) {
              expectOk(
                await editPost(database.sql, {
                  actorId: moderator.memberId,
                  postId: topic.postId,
                  bodyMd: "Redacted body.",
                  redact: true,
                }),
              );
            }

            return base.getOrRender(request);
          },
        };
        const first = await topicCache(
          database,
          null,
          `${topic.topicId}-interleaved-redaction`,
          cache,
          versions,
        );
        const firstHtml = first.kind === "page" ? first.html : "";
        expect(firstHtml).toContain("Redacted body.");
        expect(firstHtml).not.toContain("Original secret body.");

        await versions.refresh();
        const second = await topicCache(
          database,
          null,
          `${topic.topicId}-interleaved-redaction`,
          cache,
          versions,
        );
        const secondHtml = second.kind === "page" ? second.html : "";
        expect(secondHtml).toContain("Redacted body.");
        expect(secondHtml).not.toContain("Original secret body.");
      } finally {
        await versions.close();
      }
    });
  }, 45_000);

  test("public-history toggles rebuild post blocks in both directions", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberSession(database, "member-1");
      const viewer = await memberSession(database, "member-2");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author.memberId,
          forumId: offTopic,
          title: "History cache topic",
          bodyMd: "Body.",
        }),
      );
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const base = createRenderCache({ tags: versions });
        const calls: Array<{ readonly key: string; readonly status: string }> = [];
        const counted = {
          ...base,
          getOrRender: async (request: Parameters<typeof base.getOrRender>[0]) => {
            const result = await base.getOrRender(request);
            calls.push({ key: result.key, status: result.status });
            return result;
          },
        };
        const render = () =>
          topicCache(database, viewer, `${topic.topicId}-history-cache-topic`, counted, versions);

        await render();
        expect(
          calls.find((call) => call.key.startsWith(`post-block:${topic.postId}:`))?.status,
        ).toBe("miss");

        calls.length = 0;
        await database.sql`UPDATE core.board_settings SET public_edit_history = true WHERE id = 1`;
        await bumpCacheTags(database.sql, [GLOBAL_CACHE_TAGS.board]);
        await versions.refresh();
        const on = await render();
        expect(
          calls.find((call) => call.key.startsWith(`post-block:${topic.postId}:`))?.status,
        ).toBe("miss");
        expect(on.kind === "page" ? on.html : "").toContain('data-post-history="');

        calls.length = 0;
        await database.sql`UPDATE core.board_settings SET public_edit_history = false WHERE id = 1`;
        await bumpCacheTags(database.sql, [GLOBAL_CACHE_TAGS.board]);
        await versions.refresh();
        const off = await render();
        expect(
          calls.find((call) => call.key.startsWith(`post-block:${topic.postId}:`))?.status,
        ).toBe("miss");
        expect(off.kind === "page" ? off.html : "").not.toContain('data-post-history="');
      } finally {
        await versions.close();
      }
    });
  }, 45_000);

  test("unapproved quote sources never leak into shared variants", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberSession(database, "member-1");
      const other = await memberSession(database, "member-2");
      const moderator = await memberSession(database, "super-mod");
      const source = expectOk(
        await startTopic(database.sql, {
          actorId: author.memberId,
          forumId: offTopic,
          title: "Quote source",
          bodyMd: "Visible source.",
        }),
      );
      const held = expectOk(
        await reply(database.sql, {
          actorId: author.memberId,
          topicId: source.topicId,
          bodyMd: "HELD-QUOTE-SECRET",
        }),
      );
      await database.sql`
        UPDATE core.posts SET visibility = 'unapproved' WHERE id = ${held.postId}
      `;
      const target = expectOk(
        await startTopic(database.sql, {
          actorId: author.memberId,
          forumId: offTopic,
          title: "Quoted held post",
          bodyMd: `:::quote{source="post:${held.postId}"}
:::

The rest is public.`,
        }),
      );
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const render = (
          cache: ReturnType<typeof createRenderCache>,
          session: UserAppSessionContext,
        ) => topicCache(database, session, `${target.topicId}-quoted-held-post`, cache, versions);

        for (const order of [
          [author, other],
          [other, author],
        ] as const) {
          const cache = createRenderCache({ tags: versions });

          for (const session of order) {
            const page = await render(cache, session);
            const html = page.kind === "page" ? page.html : "";
            expect(html).not.toContain("HELD-QUOTE-SECRET");
          }
        }

        const moderatorPage = await render(createRenderCache({ tags: versions }), moderator);
        expect(moderatorPage.kind === "page" ? moderatorPage.html : "").toContain(
          "HELD-QUOTE-SECRET",
        );
      } finally {
        await versions.close();
      }
    });
  }, 45_000);

  test("shows author and moderator post controls with redaction on by default", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberSession(database, "member-1");
      const other = await memberSession(database, "member-2");
      const moderator = await memberSession(database, "super-mod");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author.memberId,
          forumId: offTopic,
          title: "Controls topic",
          bodyMd: "**secret markdown**",
        }),
      );
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const render = (session: UserAppSessionContext) =>
          topicCache(database, session, `${topic.topicId}-controls-topic`, cache, versions);
        const renderWithCache = (
          renderCache: ReturnType<typeof createRenderCache>,
          session: UserAppSessionContext,
        ) =>
          topicCache(database, session, `${topic.topicId}-controls-topic`, renderCache, versions);

        const authorPage = await render(author);
        const authorHtml = authorPage.kind === "page" ? authorPage.html : "";
        expect(authorHtml).not.toContain(`data-post-edit="${topic.postId}"`);
        expect(authorHtml).not.toContain(`data-post-action="soft"`);
        expect(authorHtml).not.toContain('name="redact"');
        expect(authorHtml).not.toContain("**secret markdown**");
        expect(authorHtml).toContain("<strong>secret markdown</strong>");

        const memberPage = await render(other);
        const memberHtml = memberPage.kind === "page" ? memberPage.html : "";
        expect(memberHtml).toBe(authorHtml);

        const reverseCache = createRenderCache({ tags: versions });
        const reverseMember = await renderWithCache(reverseCache, other);
        const reverseAuthor = await renderWithCache(reverseCache, author);
        expect(reverseMember.kind === "page" ? reverseMember.html : "").not.toContain(
          "**secret markdown**",
        );
        expect(reverseAuthor.kind === "page" ? reverseAuthor.html : "").toBe(
          reverseMember.kind === "page" ? reverseMember.html : "",
        );

        const moderatorPage = await render(moderator);
        const moderatorHtml = moderatorPage.kind === "page" ? moderatorPage.html : "";
        expect(moderatorHtml).toContain(`data-post-edit="${topic.postId}"`);
        expect(moderatorHtml).not.toContain('name="redact"');
        expect(moderatorHtml).toContain('data-post-history="');
        expect(moderatorHtml).toContain("data-topic-action");

        await database.sql`UPDATE core.board_settings SET public_edit_history = true WHERE id = 1`;
        await bumpCacheTags(database.sql, [GLOBAL_CACHE_TAGS.board]);
        await versions.refresh();
        const publicPage = await render(other);
        const publicHtml = publicPage.kind === "page" ? publicPage.html : "";
        expect(publicHtml).toContain('data-post-history="');
        expect(publicHtml).not.toContain('name="redact"');
      } finally {
        await versions.close();
      }
    });
  }, 45_000);
});
