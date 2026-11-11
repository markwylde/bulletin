import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { sha256Hex } from "@bulletin/domain/attachments";
import { FORUM_ACTION_BITS } from "@bulletin/domain/permissions";
import { createS3Handler } from "@bulletin/mock-s3/app";
import { createMemoryStore } from "@bulletin/mock-s3/memory";
import { createStorage, type StorageClient } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { attachmentDownloadResponse } from "../../apps/user-app/src/attachments/download.ts";
import { createCdn } from "../../mocks/cdn/src/app.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

const credentials = {
  accessKeyId: "bulletin",
  secretAccessKey: "bulletin-secret",
  region: "us-east-1",
} as const;

const DOWNLOAD_BIT = 1 << FORUM_ACTION_BITS.download;

interface Harness {
  readonly database: TestDatabase;
  readonly storage: StorageClient;
  advanceClock(ms: number): void;
}

async function withHarness(
  prefix: string,
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  let clockOffset = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: createS3Handler({
      store: createMemoryStore(),
      bucket: "bulletin",
      credentials,
      now: () => new Date(Date.now() + clockOffset),
    }),
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const storage = createStorage({
    endpoint,
    publicEndpoint: endpoint,
    bucket: "bulletin",
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region: credentials.region,
  });

  try {
    await withTestDatabase({ adminUrl, prefix }, async (database) => {
      await runSeeds({
        sql: database.sql,
        registry: new SeedRegistry([
          baseSeedModule,
          permissionFixtureSeedModule,
          groupsSeedModule,
          membersSeedModule,
        ]),
      });
      await run({
        database,
        storage,
        advanceClock(ms) {
          clockOffset += ms;
        },
      });
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

async function forumId(database: TestDatabase, slug: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${slug}`);
  }

  return row.id;
}

async function setDownloads(
  database: TestDatabase,
  maskKey: string,
  allowed: boolean,
): Promise<void> {
  if (allowed) {
    await database.sql`
      UPDATE core.forum_permissions
      SET actions = actions | ${DOWNLOAD_BIT}
      WHERE mask_id = (SELECT id FROM core.masks WHERE key = ${maskKey})
    `;
  } else {
    await database.sql`
      UPDATE core.forum_permissions
      SET actions = actions & ~(${DOWNLOAD_BIT}::int)
      WHERE mask_id = (SELECT id FROM core.masks WHERE key = ${maskKey})
    `;
  }
}

interface AttachmentFixture {
  readonly id: string;
  readonly key: string;
}

async function createAttachment(
  database: TestDatabase,
  storage: StorageClient,
  input: {
    readonly forumSlug: string;
    readonly authorId: string;
    readonly filename: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
  },
): Promise<AttachmentFixture> {
  const forum = await forumId(database, input.forumSlug);
  const [topic] = (await database.sql`
    INSERT INTO core.topics (forum_id, title, slug, starter_id)
    VALUES (${forum}, 'Attachment thread', ${`attachment-${crypto.randomUUID()}`}, ${input.authorId})
    RETURNING id
  `) as Array<{ id: string }>;

  if (topic === undefined) {
    throw new Error("Could not create the topic");
  }

  const [post] = (await database.sql`
    INSERT INTO core.posts (
      topic_id, author_id, body_md, body_html, body_text, render_version,
      sanitiser_version, position
    )
    VALUES (${topic.id}, ${input.authorId}, 'See attached', '<p>See attached</p>',
      'See attached', 1, 1, 1)
    RETURNING id
  `) as Array<{ id: string }>;

  if (post === undefined) {
    throw new Error("Could not create the post");
  }

  const key = `att/${crypto.randomUUID()}`;
  await storage.put(key, input.bytes, { contentType: input.contentType });

  const [attachment] = (await database.sql`
    INSERT INTO core.attachments (
      member_id, state, filename, declared_type, declared_bytes, quarantine_key,
      snapshot_key, storage_key, size_bytes, sha256, verified_type
    )
    VALUES (
      ${input.authorId}, 'ready', ${input.filename}, ${input.contentType},
      ${input.bytes.byteLength}, ${`quarantine/${crypto.randomUUID()}`},
      ${`processing/${crypto.randomUUID()}`}, ${key}, ${input.bytes.byteLength},
      ${sha256Hex(input.bytes)}, ${input.contentType}
    )
    RETURNING id
  `) as Array<{ id: string }>;

  if (attachment === undefined) {
    throw new Error("Could not create the attachment");
  }

  await database.sql`
    INSERT INTO core.post_attachments (post_id, attachment_id, position)
    VALUES (${post.id}, ${attachment.id}, 0)
  `;

  return { id: attachment.id, key };
}

function download(
  harness: Harness,
  id: string,
  options: {
    readonly session?: { memberId: string; sessionId: string } | null;
    readonly cookie?: boolean;
  } = {},
): Promise<Response> {
  return attachmentDownloadResponse({
    sql: harness.database.sql,
    storage: harness.storage,
    session: options.session ?? null,
    hasSessionCookie: options.cookie ?? options.session !== undefined,
    id,
  });
}

const HTML = new TextEncoder().encode("<script>alert(1)</script><p>notes</p>");
const IMAGE = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

integrationDescribe("attachment downloads (ADR 0019)", () => {
  test("a guest is refused an attachment in a members-only forum", async () => {
    await withHarness("attach_dl_denied", async (harness) => {
      const admin = await memberId(harness.database, "admin");
      const attachment = await createAttachment(harness.database, harness.storage, {
        forumSlug: "staff-room",
        authorId: admin,
        filename: "notes.html",
        contentType: "text/html",
        bytes: HTML,
      });

      const response = await download(harness, attachment.id);

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "forbidden" });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    });
  });

  test("a guest-visible HTML attachment redirects to a download-only files URL", async () => {
    await withHarness("attach_dl_html", async (harness) => {
      await setDownloads(harness.database, "guest", true);
      const admin = await memberId(harness.database, "admin");
      const attachment = await createAttachment(harness.database, harness.storage, {
        forumSlug: "off-topic",
        authorId: admin,
        filename: "notes.html",
        contentType: "text/html",
        bytes: HTML,
      });

      const response = await download(harness, attachment.id);

      expect(response.status).toBe(302);
      expect(response.headers.get("cache-control")).toBe(
        "public, s-maxage=15, stale-while-revalidate=15",
      );
      const location = response.headers.get("location");

      if (location === null) {
        throw new Error("Missing redirect location");
      }

      const url = new URL(location);
      expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
      expect(url.searchParams.get("response-content-type")).toBe("text/html");
      expect(url.searchParams.get("response-content-disposition")).toContain("attachment;");

      const file = await fetch(location);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toContain("text/html");
      expect(file.headers.get("content-disposition")).toContain("attachment;");
      expect(new TextDecoder().decode(await file.arrayBuffer())).toBe(
        "<script>alert(1)</script><p>notes</p>",
      );
    });
  });

  test("allowlisted raster images are inline and everything else is a download", async () => {
    await withHarness("attach_dl_inline", async (harness) => {
      await setDownloads(harness.database, "guest", true);
      const admin = await memberId(harness.database, "admin");
      const image = await createAttachment(harness.database, harness.storage, {
        forumSlug: "off-topic",
        authorId: admin,
        filename: "photo.webp",
        contentType: "image/webp",
        bytes: IMAGE,
      });
      const html = await createAttachment(harness.database, harness.storage, {
        forumSlug: "off-topic",
        authorId: admin,
        filename: "page.html",
        contentType: "text/html",
        bytes: HTML,
      });

      const imageResponse = await download(harness, image.id);
      const htmlResponse = await download(harness, html.id);
      const imageUrl = new URL(imageResponse.headers.get("location") ?? "");
      const htmlUrl = new URL(htmlResponse.headers.get("location") ?? "");

      expect(imageUrl.searchParams.get("response-content-disposition")).toContain("inline;");
      expect(htmlUrl.searchParams.get("response-content-disposition")).toContain("attachment;");
    });
  });

  test("a member download is private and a missing or unreferenced attachment is 404", async () => {
    await withHarness("attach_dl_member", async (harness) => {
      await setDownloads(harness.database, "standard", true);
      const member = await memberId(harness.database, "member-1");
      const attachment = await createAttachment(harness.database, harness.storage, {
        forumSlug: "off-topic",
        authorId: member,
        filename: "notes.html",
        contentType: "text/html",
        bytes: HTML,
      });

      const memberResponse = await download(harness, attachment.id, {
        session: { memberId: member, sessionId: "0" },
      });
      expect(memberResponse.status).toBe(302);
      expect(memberResponse.headers.get("cache-control")).toBe("private, no-store");

      expect((await download(harness, "999999")).status).toBe(404);

      await harness.database.sql`
        DELETE FROM core.post_attachments WHERE attachment_id = ${attachment.id}
      `;
      expect((await download(harness, attachment.id)).status).toBe(404);
    });
  });

  test("revoking access denies new requests and the issued link expires after 60 seconds", async () => {
    await withHarness("attach_dl_revoked", async (harness) => {
      await setDownloads(harness.database, "guest", true);
      const admin = await memberId(harness.database, "admin");
      const attachment = await createAttachment(harness.database, harness.storage, {
        forumSlug: "off-topic",
        authorId: admin,
        filename: "notes.html",
        contentType: "text/html",
        bytes: HTML,
      });

      const first = await download(harness, attachment.id);
      const location = first.headers.get("location");

      if (location === null) {
        throw new Error("Missing redirect location");
      }

      expect((await fetch(location)).status).toBe(200);

      await setDownloads(harness.database, "guest", false);

      const denied = await download(harness, attachment.id);
      expect(denied.status).toBe(403);

      // Already-issued links stay valid only for the 60-second presign window.
      harness.advanceClock(61_000);
      expect((await fetch(location)).status).toBe(403);
    });
  });

  test("the CDN caches only the guest redirect and never the attachment bytes", async () => {
    await withHarness("attach_dl_cdn", async (harness) => {
      await setDownloads(harness.database, "guest", true);
      const admin = await memberId(harness.database, "admin");
      const visible = await createAttachment(harness.database, harness.storage, {
        forumSlug: "off-topic",
        authorId: admin,
        filename: "notes.html",
        contentType: "text/html",
        bytes: HTML,
      });
      const privateAttachment = await createAttachment(harness.database, harness.storage, {
        forumSlug: "staff-room",
        authorId: admin,
        filename: "staff.html",
        contentType: "text/html",
        bytes: HTML,
      });

      const origin = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => {
          const id = /^\/attachments\/(\d+)/.exec(new URL(request.url).pathname)?.[1] ?? "";
          const cookie = request.headers.get("cookie") ?? "";

          return attachmentDownloadResponse({
            sql: harness.database.sql,
            storage: harness.storage,
            session: null,
            hasSessionCookie: cookie.includes("bl_session="),
            id,
          });
        },
      });
      const cdn = createCdn({ origin: `http://127.0.0.1:${origin.port}` });

      try {
        const path = `/attachments/${visible.id}/notes.html`;
        const first = await cdn.handler(new Request(`http://bulletin.localhost${path}`));
        const warm = await cdn.handler(new Request(`http://bulletin.localhost${path}`));

        expect(first.status).toBe(302);
        expect(first.headers.get("x-cache")).toBe("MISS");
        expect(first.headers.get("cache-control")).toBe(
          "public, s-maxage=15, stale-while-revalidate=15",
        );
        expect(warm.status).toBe(302);
        expect(warm.headers.get("x-cache")).toBe("HIT");
        expect(warm.headers.get("location")).toBe(first.headers.get("location"));

        const privateRedirect = await cdn.handler(
          new Request(`http://bulletin.localhost${path}`, {
            headers: { cookie: "bl_session=not-valid" },
          }),
        );
        expect(privateRedirect.headers.get("x-cache")).toBe("BYPASS");
        expect(privateRedirect.headers.get("cache-control")).toBe("private, no-store");

        const deniedPath = `/attachments/${privateAttachment.id}/staff.html`;
        const denied = await cdn.handler(new Request(`http://bulletin.localhost${deniedPath}`));
        const deniedAgain = await cdn.handler(
          new Request(`http://bulletin.localhost${deniedPath}`),
        );
        expect(denied.status).toBe(403);
        expect(denied.headers.get("x-cache")).toBe("MISS");
        expect(deniedAgain.headers.get("x-cache")).toBe("MISS");

        const location = first.headers.get("location");

        if (location === null) {
          throw new Error("Missing redirect location");
        }

        const bytes = await fetch(location);
        expect(bytes.status).toBe(200);
        // The bytes come straight from the files origin, not through the CDN.
        expect(bytes.headers.get("x-cache")).toBeNull();
      } finally {
        origin.stop(true);
      }
    });
  });
});
