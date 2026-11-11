import { describe, expect, test } from "bun:test";
import {
  processAttachment,
  runAttachmentOrphanSweep,
  runAttachmentReconciliation,
} from "@bulletin/db/jobs";
import {
  baseSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { readAttachmentById, sha256Hex } from "@bulletin/domain/attachments";
import { createS3Handler } from "@bulletin/mock-s3/app";
import { createMemoryStore } from "@bulletin/mock-s3/memory";
import { createStorage, type StorageClient } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import {
  attachmentFinaliseResponse,
  attachmentRequestResponse,
} from "../../apps/user-api/src/attachments.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

const credentials = {
  accessKeyId: "bulletin",
  secretAccessKey: "bulletin-secret",
  region: "us-east-1",
} as const;

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
      credentials,
    }),
  });
  const storage = createStorage({
    endpoint: `http://127.0.0.1:${server.port}`,
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

async function forumId(database: TestDatabase, slug: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${slug}`);
  }

  return row.id;
}

/** Every group with upload permission gets the same test limits (merge rule is max). */
async function setUploadLimits(
  database: TestDatabase,
  limits: { readonly quotaMb: number; readonly perFileKb: number },
): Promise<void> {
  for (const [key, value] of [
    ["posting.upload_quota_mb", limits.quotaMb],
    ["posting.upload_per_file_kb", limits.perFileKb],
  ] as const) {
    await database.sql`
      INSERT INTO core.group_settings (group_id, key, value)
      SELECT id, ${key}, to_jsonb(${value}::int)
      FROM core.groups
      ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
    `;
  }
}

function sessionFor(member: string) {
  return { memberId: member, sessionId: "0" };
}

function uploadRequest(body: Record<string, unknown>): Request {
  return new Request("http://bulletin.localhost/api/attachments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface UploadResponse {
  readonly id: string;
  readonly state: string;
  readonly remainingBytes: number;
  readonly upload: { readonly url: string; readonly contentLength: number };
}

async function requestUpload(
  harness: Harness,
  member: string,
  body: {
    readonly forumId: string;
    readonly filename: string;
    readonly contentType: string;
    readonly sizeBytes: number;
  },
): Promise<Response> {
  return attachmentRequestResponse(
    harness.database.sql,
    harness.storage,
    sessionFor(member),
    uploadRequest(body),
  );
}

async function uploadBytes(
  harness: Harness,
  member: string,
  bytes: Uint8Array,
  contentType: string,
) {
  const forum = await forumId(harness.database, "off-topic");
  const response = await requestUpload(harness, member, {
    forumId: forum,
    filename: "upload.bin",
    contentType,
    sizeBytes: bytes.byteLength,
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as UploadResponse;
  const put = await fetch(body.upload.url, { method: "PUT", body: bytes });
  expect(put.status).toBe(200);

  return body;
}

async function finalise(harness: Harness, member: string, id: string): Promise<Response> {
  return attachmentFinaliseResponse(harness.database.sql, harness.storage, sessionFor(member), id);
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

integrationDescribe("attachment upload request", () => {
  test("refuses a forum where the member cannot upload", async () => {
    await withHarness("attach_permission", async (harness) => {
      await setUploadLimits(harness.database, { quotaMb: 10, perFileKb: 10_240 });
      const member = await memberId(harness.database, "member-1");
      const staffRoom = await forumId(harness.database, "staff-room");

      const response = await requestUpload(harness, member, {
        forumId: staffRoom,
        filename: "leak.txt",
        contentType: "text/plain",
        sizeBytes: 10,
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "forbidden" });

      const rows = (await harness.database.sql`
        SELECT count(*)::int AS count FROM core.attachments
      `) as Array<{ count: number }>;
      expect(rows[0]?.count).toBe(0);
    });
  });

  test("refuses a file type outside the allowlist", async () => {
    await withHarness("attach_type", async (harness) => {
      await setUploadLimits(harness.database, { quotaMb: 10, perFileKb: 10_240 });
      const member = await memberId(harness.database, "member-1");
      const forum = await forumId(harness.database, "off-topic");

      const response = await requestUpload(harness, member, {
        forumId: forum,
        filename: "setup.exe",
        contentType: "application/x-msdownload",
        sizeBytes: 1024,
      });

      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ code: "type_not_allowed" });
    });
  });

  test("refuses a file above the per-file limit", async () => {
    await withHarness("attach_per_file", async (harness) => {
      await setUploadLimits(harness.database, { quotaMb: 10, perFileKb: 1 });
      const member = await memberId(harness.database, "member-1");
      const forum = await forumId(harness.database, "off-topic");

      const response = await requestUpload(harness, member, {
        forumId: forum,
        filename: "big.txt",
        contentType: "text/plain",
        sizeBytes: 2048,
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ code: "file_too_large", maxBytes: 1024 });
    });
  });

  test("shows the remaining quota and refuses an upload that exceeds it", async () => {
    await withHarness("attach_quota", async (harness) => {
      await setUploadLimits(harness.database, { quotaMb: 5, perFileKb: 10_240 });
      const member = await memberId(harness.database, "member-1");
      const forum = await forumId(harness.database, "off-topic");
      const threeMegabytes = 3 * 1024 * 1024;

      await harness.database.sql`
        INSERT INTO core.member_storage (member_id, used_bytes)
        VALUES (${member}, ${threeMegabytes})
        ON CONFLICT (member_id) DO UPDATE SET used_bytes = EXCLUDED.used_bytes
      `;

      const refused = await requestUpload(harness, member, {
        forumId: forum,
        filename: "five.pdf",
        contentType: "application/pdf",
        sizeBytes: 5 * 1024 * 1024,
      });

      expect(refused.status).toBe(413);
      expect(await refused.json()).toEqual({
        code: "quota_exceeded",
        remainingBytes: 2 * 1024 * 1024,
        limitBytes: 5 * 1024 * 1024,
      });

      const accepted = await requestUpload(harness, member, {
        forumId: forum,
        filename: "one.pdf",
        contentType: "application/pdf",
        sizeBytes: 1024 * 1024,
      });

      expect(accepted.status).toBe(201);
      const body = (await accepted.json()) as UploadResponse;
      expect(body.remainingBytes).toBe(1024 * 1024);
      expect(body.state).toBe("pending");
      expect(body.upload.contentLength).toBe(1024 * 1024);

      const storageRows = (await harness.database.sql`
        SELECT reserved_bytes::text AS reserved_bytes FROM core.member_storage
        WHERE member_id = ${member}
      `) as Array<{ reserved_bytes: string }>;
      expect(storageRows[0]?.reserved_bytes).toBe(String(1024 * 1024));
    });
  });
});

integrationDescribe("attachment finalise and processing", () => {
  test("snapshots the finalised bytes and ignores a replayed quarantine upload", async () => {
    await withHarness("attach_finalise", async (harness) => {
      await setUploadLimits(harness.database, { quotaMb: 10, perFileKb: 10_240 });
      const member = await memberId(harness.database, "member-1");
      const original = textBytes("the bytes that were finalised");
      const upload = await uploadBytes(harness, member, original, "text/plain");

      const first = await finalise(harness, member, upload.id);
      expect(first.status).toBe(200);
      const snapshotted = (await first.json()) as { id: string; state: string; sizeBytes: number };
      expect(snapshotted.state).toBe("snapshotted");
      expect(snapshotted.sizeBytes).toBe(original.byteLength);

      const again = await finalise(harness, member, upload.id);
      expect(again.status).toBe(200);
      expect(((await again.json()) as { state: string }).state).toBe("snapshotted");

      const replaced = textBytes("X".repeat(original.byteLength));
      const replay = await fetch(upload.upload.url, { method: "PUT", body: replaced });
      expect(replay.status).toBe(200);

      const result = await processAttachment(harness.database.sql, harness.storage, upload.id);
      expect(result.kind).toBe("ready");

      const record = await readAttachmentById(harness.database.sql, upload.id);
      expect(record?.state).toBe("ready");
      expect(record?.sizeBytes).toBe(original.byteLength);
      expect(record?.sha256).toBe(sha256Hex(original));
      expect(record?.storageKey).not.toBeNull();
      expect(new TextDecoder().decode(await harness.storage.get(record?.storageKey ?? ""))).toBe(
        "the bytes that were finalised",
      );
    });
  });

  test("refuses to finalise another member's upload", async () => {
    await withHarness("attach_owner", async (harness) => {
      await setUploadLimits(harness.database, { quotaMb: 10, perFileKb: 10_240 });
      const owner = await memberId(harness.database, "member-1");
      const other = await memberId(harness.database, "member-2");
      const upload = await uploadBytes(harness, owner, textBytes("owner only"), "text/plain");

      const denied = await finalise(harness, other, upload.id);
      expect(denied.status).toBe(404);

      const record = await readAttachmentById(harness.database.sql, upload.id);
      expect(record?.state).toBe("pending");
    });
  });

  test("rejects a disguised executable and releases its quota", async () => {
    await withHarness("attach_executable", async (harness) => {
      await setUploadLimits(harness.database, { quotaMb: 10, perFileKb: 10_240 });
      const member = await memberId(harness.database, "member-1");
      const executable = new Uint8Array(0x80);
      executable.set([0x4d, 0x5a]);
      new DataView(executable.buffer).setUint32(0x3c, 0x40, true);
      executable.set([0x50, 0x45, 0, 0], 0x40);

      const upload = await uploadBytes(harness, member, executable, "image/jpeg");
      expect((await finalise(harness, member, upload.id)).status).toBe(200);

      const result = await processAttachment(harness.database.sql, harness.storage, upload.id);
      expect(result.kind).toBe("rejected");

      const record = await readAttachmentById(harness.database.sql, upload.id);
      expect(record?.state).toBe("rejected");
      expect(record?.rejectionCode).toBe("type_not_allowed");
      expect(record?.storageKey).toBeNull();
      expect(await harness.storage.list("att/")).toHaveLength(0);

      const storageRows = (await harness.database.sql`
        SELECT used_bytes::text AS used_bytes, reserved_bytes::text AS reserved_bytes
        FROM core.member_storage WHERE member_id = ${member}
      `) as Array<{ used_bytes: string; reserved_bytes: string }>;
      expect(storageRows[0]).toEqual({ used_bytes: "0", reserved_bytes: "0" });

      const afterRejection = await finalise(harness, member, upload.id);
      expect(afterRejection.status).toBe(409);
      expect((await afterRejection.json()) as { code: string }).toMatchObject({
        code: "attachment_rejected",
      });
    });
  });

  test("gives the scan hook a veto", async () => {
    await withHarness("attach_scan", async (harness) => {
      await setUploadLimits(harness.database, { quotaMb: 10, perFileKb: 10_240 });
      const member = await memberId(harness.database, "member-1");
      const upload = await uploadBytes(harness, member, textBytes("looks harmless"), "text/plain");

      await finalise(harness, member, upload.id);

      let scanned = 0;
      const result = await processAttachment(harness.database.sql, harness.storage, upload.id, {
        scan: ({ contentType }) => {
          scanned += 1;
          expect(contentType).toBe("text/plain");
          return "infected";
        },
      });

      expect(scanned).toBe(1);
      expect(result.kind).toBe("rejected");
      const record = await readAttachmentById(harness.database.sql, upload.id);
      expect(record?.rejectionCode).toBe("malware_detected");
    });
  });
});

integrationDescribe("attachment cleanup", () => {
  test("deletes an abandoned upload after 24 hours and releases quota", async () => {
    await withHarness("attach_orphan", async (harness) => {
      await setUploadLimits(harness.database, { quotaMb: 10, perFileKb: 10_240 });
      const member = await memberId(harness.database, "member-1");
      const upload = await uploadBytes(harness, member, textBytes("never posted"), "text/plain");

      const [row] = (await harness.database.sql`
        SELECT quarantine_key FROM core.attachments WHERE id = ${upload.id}
      `) as Array<{ quarantine_key: string }>;
      expect(await harness.storage.exists(row?.quarantine_key ?? "")).toBe(true);

      await harness.database.sql`
        UPDATE core.attachments SET expires_at = now() - interval '1 minute'
        WHERE id = ${upload.id}
      `;

      const result = await runAttachmentOrphanSweep(harness.database.sql, harness.storage);

      expect(result.deleted).toBe(1);
      expect(await readAttachmentById(harness.database.sql, upload.id)).toBeNull();
      expect(await harness.storage.exists(row?.quarantine_key ?? "")).toBe(false);

      const storageRows = (await harness.database.sql`
        SELECT used_bytes::text AS used_bytes, reserved_bytes::text AS reserved_bytes
        FROM core.member_storage WHERE member_id = ${member}
      `) as Array<{ used_bytes: string; reserved_bytes: string }>;
      expect(storageRows[0]).toEqual({ used_bytes: "0", reserved_bytes: "0" });
    });
  });

  test("keeps a ready attachment before its deadline", async () => {
    await withHarness("attach_orphan_live", async (harness) => {
      await setUploadLimits(harness.database, { quotaMb: 10, perFileKb: 10_240 });
      const member = await memberId(harness.database, "member-1");
      const upload = await uploadBytes(harness, member, textBytes("posted soon"), "text/plain");
      await finalise(harness, member, upload.id);
      expect((await processAttachment(harness.database.sql, harness.storage, upload.id)).kind).toBe(
        "ready",
      );

      const result = await runAttachmentOrphanSweep(harness.database.sql, harness.storage);

      expect(result.deleted).toBe(0);
      expect((await readAttachmentById(harness.database.sql, upload.id))?.state).toBe("ready");
    });
  });

  test("reconciliation removes bucket objects with no attachment row", async () => {
    await withHarness("attach_reconcile", async (harness) => {
      await setUploadLimits(harness.database, { quotaMb: 10, perFileKb: 10_240 });
      const member = await memberId(harness.database, "member-1");
      const upload = await uploadBytes(harness, member, textBytes("kept"), "text/plain");
      await finalise(harness, member, upload.id);
      await processAttachment(harness.database.sql, harness.storage, upload.id);

      const record = await readAttachmentById(harness.database.sql, upload.id);
      const liveKey = record?.storageKey ?? "";
      await harness.storage.put("att/stray", "stray");
      await harness.storage.put("quarantine/stray", "stray");
      await harness.storage.put("processing/stray", "stray");
      await harness.storage.put(`unfurl/${"b".repeat(64)}`, "stray");
      await harness.storage.put(`${liveKey}.thumb.webp`, "thumbnail");
      // Finalised rows no longer own their quarantine or snapshot keys: a replay is stray.
      await harness.storage.put(record?.quarantineKey ?? "", "replayed");
      await harness.storage.put(record?.snapshotKey ?? "", "leftover");

      const result = await runAttachmentReconciliation(harness.database.sql, harness.storage);

      expect(result.deleted).toBe(6);
      expect(await harness.storage.exists(liveKey)).toBe(true);
      expect(await harness.storage.exists(`${liveKey}.thumb.webp`)).toBe(true);
      expect(await harness.storage.exists("att/stray")).toBe(false);
      expect(await harness.storage.exists("quarantine/stray")).toBe(false);
      expect(await harness.storage.exists("processing/stray")).toBe(false);
      expect(await harness.storage.exists(`unfurl/${"b".repeat(64)}`)).toBe(false);
      expect(await harness.storage.exists(record?.quarantineKey ?? "")).toBe(false);
      expect(await harness.storage.exists(record?.snapshotKey ?? "")).toBe(false);
    });
  });
});
