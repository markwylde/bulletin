import { describe, expect, test } from "bun:test";
import { runBaseSeed } from "@bulletin/db/seed";
import type { StorageClient } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { strFromU8, unzipSync } from "fflate";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

function recordingStorage(): {
  readonly storage: StorageClient;
  readonly objects: Map<string, Uint8Array>;
} {
  const objects = new Map<string, Uint8Array>();

  return {
    objects,
    storage: {
      async put(key, data) {
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        objects.set(key, bytes);
        return bytes.byteLength;
      },
      async get(key) {
        return objects.get(key) ?? new Uint8Array();
      },
      async exists(key) {
        return objects.has(key);
      },
      async stat() {
        return { size: 0, contentType: "application/octet-stream", etag: "" };
      },
      async delete(key) {
        objects.delete(key);
      },
      async copy() {},
      async list() {
        return [];
      },
      presignGet() {
        return "";
      },
      presignPut() {
        return "";
      },
    },
  };
}

async function withSeededDb(
  run: (database: TestDatabase, storage: ReturnType<typeof recordingStorage>) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "privacy_seed" }, async (database) => {
    const storage = recordingStorage();
    await runBaseSeed({
      databaseUrl: database.url,
      seed: 42,
      size: "default",
      storage: storage.storage,
    });
    await run(database, storage);
  });
}

integrationDescribe("privacy seed", () => {
  test("seeds an export, an erasure request, access-log rows and the policy", async () => {
    await withSeededDb(async (database, storage) => {
      const requests = (await database.sql`
        SELECT r.kind, r.status, r.export_key, r.export_expires_at, i.sub
        FROM pii.data_requests r
        JOIN pii.identities i ON i.member_id = r.member_id
        ORDER BY r.id
      `) as Array<{
        kind: string;
        status: string;
        export_key: string | null;
        export_expires_at: Date | null;
        sub: string;
      }>;

      expect(requests).toEqual([
        expect.objectContaining({
          kind: "export",
          status: "completed",
          export_key: "export/seed-member-1.zip",
          sub: "member-1",
        }),
        expect.objectContaining({ kind: "erasure", status: "pending", sub: "member-2" }),
      ]);
      expect(requests[0]?.export_expires_at?.getTime()).toBeGreaterThan(Date.now());

      const archive = storage.objects.get("export/seed-member-1.zip");
      expect(archive).toBeDefined();

      if (archive !== undefined) {
        const files = unzipSync(archive);
        expect(strFromU8(files["profile.json"] ?? new Uint8Array())).toContain(
          "Regular Member One",
        );
      }

      const log = (await database.sql`
        SELECT purpose FROM pii.access_log ORDER BY id
      `) as Array<{ purpose: string }>;
      expect(log.map((entry) => entry.purpose)).toEqual(
        expect.arrayContaining(["post_ip", "login_ips", "own_data"]),
      );

      const [policy] = (await database.sql`
        SELECT policy_md, policy_html, policy_updated_at
        FROM core.privacy_settings WHERE id = 1
      `) as Array<{
        policy_md: string;
        policy_html: string;
        policy_updated_at: Date | null;
      }>;
      expect(policy?.policy_md).toContain("Privacy policy");
      expect(policy?.policy_html).toContain("Privacy policy");
      expect(policy?.policy_updated_at).not.toBeNull();
    });
  }, 120_000);
});
