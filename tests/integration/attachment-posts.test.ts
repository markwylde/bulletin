import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions, postTag, readTagVersion } from "@bulletin/cache";
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
import { deleteAttachment } from "@bulletin/domain/attachments";
import { startTopic } from "@bulletin/domain/topics";
import { createServerT } from "@bulletin/i18n";
import { assertCacheVariants, type VariantCase } from "@bulletin/test-utils/cache-variants";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "attachment_posts" }, async (database) => {
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

async function createAttachment(
  database: TestDatabase,
  input: {
    readonly memberId: string;
    readonly filename: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly downloadCount?: number;
  },
): Promise<string> {
  const [row] = (await database.sql`
    INSERT INTO core.attachments (
      member_id, state, filename, declared_type, declared_bytes, quarantine_key,
      snapshot_key, storage_key, size_bytes, sha256, verified_type, download_count
    )
    VALUES (
      ${input.memberId}, 'ready', ${input.filename}, ${input.contentType},
      ${input.sizeBytes}, ${`quarantine/${crypto.randomUUID()}`},
      ${`processing/${crypto.randomUUID()}`}, ${`att/${crypto.randomUUID()}`},
      ${input.sizeBytes}, ${"a".repeat(64)}, ${input.contentType}, ${input.downloadCount ?? 0}
    )
    RETURNING id
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error("Could not create the attachment");
  }

  return row.id;
}

function ok<T>(
  outcome:
    | { readonly ok: true; readonly result: T }
    | { readonly ok: false; readonly code: string },
): T {
  if (!outcome.ok) {
    throw new Error(`Expected success, received ${outcome.code}`);
  }

  return outcome.result;
}

function topicCache(
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

integrationDescribe("attachments in posts", () => {
  test("renders inline images and a file list with sizes and download counts", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberSession(database, "member-1");
      const imageId = await createAttachment(database, {
        memberId: author.memberId,
        filename: "photo.webp",
        contentType: "image/webp",
        sizeBytes: 2048,
        downloadCount: 3,
      });
      const fileId = await createAttachment(database, {
        memberId: author.memberId,
        filename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 4096,
        downloadCount: 1,
      });
      const missingId = "999999";
      const topic = ok(
        await startTopic(database.sql, {
          actorId: author.memberId,
          forumId: offTopic,
          title: "Attachments in posts",
          bodyMd: `![photo.webp](attachment:${imageId})\n\n[report.pdf](attachment:${fileId})\n\n[gone.pdf](attachment:${missingId})`,
        }),
      );
      const versions = await createTagVersions({ sql: database.sql });
      const cache = createRenderCache({ tags: versions });

      try {
        const result = await topicCache(
          database,
          null,
          `${topic.topicId}-attachments-in-posts`,
          cache,
          versions,
        );

        expect(result.kind).toBe("page");
        const html = result.kind === "page" ? result.html : "";

        expect(html).toContain('class="bl-attachment-image"');
        expect(html).toContain(`src="/attachments/${imageId}/photo.webp"`);
        expect(html).toContain(`data-post-attachments="${topic.postId}"`);
        expect(html).toContain("report.pdf");
        expect(html).toContain("4 kB");
        expect(html).toContain("1 download");
        expect(html).toContain("Attachment removed");
        expect(html).not.toContain(`src="/attachments/${fileId}/report.pdf"`);
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("renders an inline SVG through the raster preview, not the original object", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberSession(database, "member-1");
      const svgId = await createAttachment(database, {
        memberId: author.memberId,
        filename: "vector.svg",
        contentType: "image/svg+xml",
        sizeBytes: 512,
      });
      const topic = ok(
        await startTopic(database.sql, {
          actorId: author.memberId,
          forumId: offTopic,
          title: "SVG preview",
          bodyMd: `![vector.svg](attachment:${svgId})`,
        }),
      );
      const versions = await createTagVersions({ sql: database.sql });
      const cache = createRenderCache({ tags: versions });

      try {
        const result = await topicCache(
          database,
          null,
          `${topic.topicId}-svg-preview`,
          cache,
          versions,
        );
        const html = result.kind === "page" ? result.html : "";

        expect(html).toContain(`src="/attachments/${svgId}?preview=1"`);
        expect(html).not.toContain(`src="/attachments/${svgId}/vector.svg"`);
        expect(html).not.toContain("data-post-files");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("a refreshed post block shows a deleted attachment as removed", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberSession(database, "member-1");
      const attachmentId = await createAttachment(database, {
        memberId: author.memberId,
        filename: "secret-report.pdf",
        contentType: "application/pdf",
        sizeBytes: 4096,
      });
      const topic = ok(
        await startTopic(database.sql, {
          actorId: author.memberId,
          forumId: offTopic,
          title: "Attachment deletion",
          bodyMd: `[secret-report.pdf](attachment:${attachmentId})`,
        }),
      );
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });
      const cache = createRenderCache({ tags: versions });

      try {
        const before = await topicCache(
          database,
          null,
          `${topic.topicId}-attachment-deletion`,
          cache,
          versions,
        );
        expect(before.kind === "page" ? before.html : "").toContain("secret-report.pdf");

        const beforeVersion = await readTagVersion(database.sql, postTag(topic.postId));
        const deleted = await deleteAttachment(database.sql, {
          actorId: author.memberId,
          attachmentId,
        });
        expect(deleted).toMatchObject({ ok: true, postIds: [topic.postId] });
        expect(await readTagVersion(database.sql, postTag(topic.postId))).not.toBe(beforeVersion);
        await versions.refresh();

        const after = await topicCache(
          database,
          null,
          `${topic.topicId}-attachment-deletion`,
          cache,
          versions,
        );
        const html = after.kind === "page" ? after.html : "";

        expect(html).not.toContain("secret-report.pdf");
        expect(html).toContain("Attachment removed");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("applies the cache variant harness to the attachment page", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberSession(database, "member-1");
      const attachmentId = await createAttachment(database, {
        memberId: author.memberId,
        filename: "guest-visible.pdf",
        contentType: "application/pdf",
        sizeBytes: 1024,
      });
      const topic = ok(
        await startTopic(database.sql, {
          actorId: author.memberId,
          forumId: offTopic,
          title: "Guest attachment variant",
          bodyMd: `[guest-visible.pdf](attachment:${attachmentId})`,
        }),
      );
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });
      const cache = createRenderCache({ tags: versions });

      try {
        const cases: VariantCase[] = [
          {
            name: "guest",
            render: async () => {
              const result = await topicCache(
                database,
                null,
                `${topic.topicId}-guest-attachment-variant`,
                cache,
                versions,
              );

              return {
                variant: result.variant ?? "",
                html: result.kind === "page" ? result.html : "",
                ...(result.cache === null ? {} : { cache: result.cache }),
              };
            },
          },
          {
            name: "member",
            render: async () => {
              const result = await topicCache(
                database,
                author,
                `${topic.topicId}-guest-attachment-variant`,
                cache,
                versions,
              );

              return {
                variant: result.variant ?? "",
                html: result.kind === "page" ? result.html : "",
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
              description: "the upload editor never appears in the guest variant",
              markers: ['data-editor-can-upload="true"'],
              absentFrom: ["guest"],
            },
          ],
        });
      } finally {
        await versions.close();
      }
    });
  }, 45_000);
});
