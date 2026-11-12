import { describe, expect, test } from "bun:test";
import { listForumsNeedingLanguageRebuild, rebuildForumLanguage } from "@bulletin/db/jobs";
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
} from "@bulletin/db/seed";
import { editPost, reply, startTopic } from "@bulletin/domain/topics";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { saveForumSettings } from "../../apps/staff-api/src/forums.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "search_index" }, async (database) => {
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

async function forumId(database: TestDatabase, slug: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${slug}`);
  }

  return row.id;
}

async function expectOk<T>(
  outcome:
    | { readonly ok: true; readonly result: T }
    | { readonly ok: false; readonly code: string },
): Promise<T> {
  if (!outcome.ok) {
    throw new Error(`Expected success, received ${outcome.code}`);
  }

  return outcome.result;
}

async function matchingPosts(
  database: TestDatabase,
  config: "english" | "spanish" | "simple",
  query: string,
): Promise<readonly string[]> {
  const rows = (await database.sql`
    SELECT id::text AS id
    FROM core.posts
    WHERE tsv @@ websearch_to_tsquery(${config}::regconfig, ${query})
  `) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

async function matchingSimplePosts(
  database: TestDatabase,
  query: string,
): Promise<readonly string[]> {
  const rows = (await database.sql`
    SELECT id::text AS id
    FROM core.posts
    WHERE tsv_simple @@ websearch_to_tsquery('simple', ${query})
  `) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

async function matchingTopics(
  database: TestDatabase,
  config: "english" | "spanish" | "simple",
  query: string,
): Promise<readonly string[]> {
  const rows = (await database.sql`
    SELECT id::text AS id
    FROM core.topics
    WHERE tsv @@ websearch_to_tsquery(${config}::regconfig, ${query})
  `) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

integrationDescribe("search index", () => {
  test("indexes a topic and post immediately, including edits", async () => {
    await withSeededDb(async (database) => {
      const announcements = await forumId(database, "announcements");
      const author = await memberId(database, "member-1");

      await database.sql`
        UPDATE core.forums SET language = 'en' WHERE id = ${announcements}
      `;

      const created = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: announcements,
          title: "Running gear for the season",
          bodyMd: "I am running daily and found a marker quokkafinder in the notes.",
        }),
      );

      const [topic] = (await database.sql`
        SELECT lang::text AS lang FROM core.topics WHERE id = ${created.topicId}
      `) as Array<{ lang: string }>;
      const [post] = (await database.sql`
        SELECT lang::text AS lang FROM core.posts WHERE id = ${created.postId}
      `) as Array<{ lang: string }>;

      expect(topic?.lang).toBe("english");
      expect(post?.lang).toBe("english");
      // Generated columns make both the exact word and the English stem visible at once.
      expect(await matchingPosts(database, "english", "quokkafinder")).toContain(created.postId);
      expect(await matchingPosts(database, "english", "run")).toContain(created.postId);
      expect(await matchingTopics(database, "english", "run")).toContain(created.topicId);
      expect(await matchingSimplePosts(database, "running")).toContain(created.postId);

      await expectOk(
        await editPost(database.sql, {
          actorId: author,
          postId: created.postId,
          bodyMd: "The edit replaced the marker with a xylophonist.",
        }),
      );

      expect(await matchingPosts(database, "english", "quokkafinder")).not.toContain(
        created.postId,
      );
      expect(await matchingPosts(database, "english", "xylophonist")).toContain(created.postId);
    });
  });

  test("rebuilds a forum's language in batches after the setting changes", async () => {
    await withSeededDb(async (database) => {
      const announcements = await forumId(database, "announcements");
      const author = await memberId(database, "member-1");
      const admin = await memberId(database, "admin");

      const created = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: announcements,
          title: "Corriendo por la mañana",
          bodyMd: "Estoy corriendo todos los días antes del desayuno.",
        }),
      );

      for (let index = 0; index < 3; index += 1) {
        await expectOk(
          await reply(database.sql, {
            actorId: author,
            topicId: created.topicId,
            bodyMd: `Comentario ${index + 1}: sigo corriendo por el parque.`,
          }),
        );
      }

      const before = await matchingPosts(database, "spanish", "correr");
      expect(before).toHaveLength(0);

      const saved = await saveForumSettings(database.sql, admin, {
        id: announcements,
        language: "es",
        prefixIds: [],
      });
      expect(saved.ok).toBe(true);

      const [versions] = (await database.sql`
        SELECT search_lang_version::text AS version,
          search_lang_indexed_version::text AS indexed
        FROM core.forums WHERE id = ${announcements}
      `) as Array<{ version: string; indexed: string }>;
      expect(versions?.version).toBe("1");
      expect(versions?.indexed).toBe("0");

      const pending = await listForumsNeedingLanguageRebuild(database.sql);
      expect(pending).toContainEqual({ forumId: announcements, version: "1" });

      const rebuilt = await rebuildForumLanguage(database.sql, announcements, { batchSize: 2 });
      expect(rebuilt.posts).toBe(4);
      expect(rebuilt.batches).toBeGreaterThan(1);

      const [forum] = (await database.sql`
        SELECT search_lang_version::text AS version,
          search_lang_indexed_version::text AS indexed
        FROM core.forums WHERE id = ${announcements}
      `) as Array<{ version: string; indexed: string }>;
      expect(forum).toEqual({ version: "1", indexed: "1" });
      expect(await listForumsNeedingLanguageRebuild(database.sql)).toHaveLength(0);

      const [topic] = (await database.sql`
        SELECT lang::text AS lang FROM core.topics WHERE id = ${created.topicId}
      `) as Array<{ lang: string }>;
      expect(topic?.lang).toBe("spanish");

      const [post] = (await database.sql`
        SELECT lang::text AS lang FROM core.posts WHERE id = ${created.postId}
      `) as Array<{ lang: string }>;
      expect(post?.lang).toBe("spanish");
      expect(await matchingPosts(database, "spanish", "correr")).toContain(created.postId);
      expect(await matchingSimplePosts(database, "corriendo")).toContain(created.postId);
    });
  });
});
