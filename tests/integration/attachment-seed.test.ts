import { describe, expect, test } from "bun:test";
import {
  attachmentSeedModule,
  baseSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  topicsSeedModule,
} from "@bulletin/db/seed";
import { readPostAttachments } from "@bulletin/domain/attachments";
import { createServerT } from "@bulletin/i18n";
import { createS3Handler } from "@bulletin/mock-s3/app";
import { createMemoryStore } from "@bulletin/mock-s3/memory";
import { avatarKey, createStorage, type StorageClient } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderPostAttachments } from "../../apps/user-app/src/topics/attachments.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

interface Harness {
  readonly database: TestDatabase;
  readonly storage: StorageClient;
}

async function withHarness(
  prefix: string,
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: createS3Handler({
      store: createMemoryStore(),
      bucket: "bulletin",
      credentials: {
        accessKeyId: "bulletin",
        secretAccessKey: "bulletin-secret",
        region: "us-east-1",
      },
    }),
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const storage = createStorage({
    endpoint,
    publicEndpoint: endpoint,
    bucket: "bulletin",
    accessKeyId: "bulletin",
    secretAccessKey: "bulletin-secret",
    region: "us-east-1",
  });

  try {
    await withTestDatabase({ adminUrl, prefix }, async (database) => {
      await runSeeds({
        sql: database.sql,
        storage,
        registry: new SeedRegistry([
          baseSeedModule,
          permissionFixtureSeedModule,
          groupsSeedModule,
          forumExtrasSeedModule,
          membersSeedModule,
          topicsSeedModule,
          attachmentSeedModule,
        ]),
      });
      await run({ database, storage });
    });
  } finally {
    server.stop(true);
  }
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

integrationDescribe("attachment and avatar seed (task 6.3)", () => {
  test("seeds avatars for a subset and attachments in public and staff posts", async () => {
    await withHarness("attachment_seed", async ({ database, storage }) => {
      for (const sub of ["member-1", "member-2", "admin"]) {
        const member = await memberId(database, sub);
        const [row] = (await database.sql`
          SELECT avatar_hash FROM core.members WHERE id = ${member}
        `) as Array<{ avatar_hash: string | null }>;
        const hash = row?.avatar_hash;

        expect(hash).toMatch(/^[0-9a-f]{64}$/);

        for (const variant of ["lg", "md", "sm"]) {
          expect(await storage.exists(avatarKey(member, hash ?? "", variant))).toBe(true);
        }
      }

      const [publicTopic] = (await database.sql`
        SELECT t.id::text AS topic_id, p.id::text AS post_id, p.body_html
        FROM core.topics t
        JOIN core.posts p ON p.topic_id = t.id AND p.position = 1
        WHERE t.title = 'A garden update with photos'
      `) as Array<{ topic_id: string; post_id: string; body_html: string }>;

      expect(publicTopic).toBeDefined();
      expect(publicTopic?.body_html).toContain("bl-attachment");

      const attachments = await readPostAttachments(database.sql, [publicTopic?.post_id ?? ""]);
      const list = attachments.get(publicTopic?.post_id ?? "") ?? [];
      expect(list.map((attachment) => attachment.filename).sort()).toEqual([
        "garden-notes.txt",
        "garden-photo.png",
      ]);

      const rendered = renderPostAttachments({
        postId: publicTopic?.post_id ?? "",
        html: publicTopic?.body_html ?? "",
        attachments: list,
        locale: "en",
        translate,
        canRemove: false,
      });
      expect(rendered.bodyHtml).toContain("garden-photo.png");
      expect(rendered.files).not.toBeNull();
      expect(rendered.files?.html ?? "").toContain("garden-notes.txt");

      const image = list.find((attachment) => attachment.filename === "garden-photo.png");
      expect(image?.contentType).toBe("image/webp");

      const [imageRow] = (await database.sql`
        SELECT storage_key FROM core.attachments WHERE filename = 'garden-photo.png'
      `) as Array<{ storage_key: string }>;
      expect(await storage.exists(imageRow?.storage_key ?? "")).toBe(true);
      expect(await storage.exists(`${imageRow?.storage_key ?? ""}.thumb.webp`)).toBe(true);

      const [staffTopic] = (await database.sql`
        SELECT p.id::text AS post_id
        FROM core.topics t
        JOIN core.posts p ON p.topic_id = t.id AND p.position = 1
        JOIN core.forums f ON f.id = t.forum_id
        WHERE t.title = 'Staff room attachments' AND f.slug = 'staff-room'
      `) as Array<{ post_id: string }>;

      expect(staffTopic).toBeDefined();
      const staffAttachments = await readPostAttachments(database.sql, [staffTopic?.post_id ?? ""]);
      expect(staffAttachments.get(staffTopic?.post_id ?? "")?.[0]?.filename).toBe(
        "staff-room-notes.txt",
      );
    });
  }, 45_000);
});
