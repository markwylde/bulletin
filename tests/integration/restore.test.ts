import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  detectRestore,
  prepareAfterRestore,
  runErasureJob,
  runPostRestore,
  scanMissingObjects,
  writeRestoreWatermark,
} from "@bulletin/db/jobs";
import {
  baseSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import type { SessionRecord } from "@bulletin/domain/auth";
import {
  createJournalReadinessCheck,
  JOURNAL_HEAD_KEY,
  journalApplied,
} from "@bulletin/domain/operations";
import { createS3Handler } from "@bulletin/mock-s3/app";
import { createMemoryStore } from "@bulletin/mock-s3/memory";
import { createPostgresStore } from "@bulletin/mock-s3/postgres";
import { createStorage, type StorageClient } from "@bulletin/storage";
import { createTestDatabase, type TestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";
import {
  authorizeStaffRoute,
  STAFF_ROUTES,
  type StaffRoute,
  type StaffRouteContext,
} from "../../apps/staff-api/src/api.ts";
import type { MissingObjectsReport } from "../../apps/staff-api/src/missing-objects.ts";
import { attachmentDownloadResponse } from "../../apps/user-app/src/attachments/download.ts";

/**
 * Backups and restores (ADR 0020, ADR 0012; operations-observability tasks 4.2 and 4.4). A
 * "backup" is a `CREATE DATABASE … TEMPLATE` copy; restoring means continuing on a fresh copy
 * of that backup while object storage (the journal, the files) keeps everything written since.
 */

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const credentials = {
  accessKeyId: "bulletin",
  secretAccessKey: "bulletin-secret",
  region: "us-east-1",
} as const;

function roleUrl(databaseUrl: string, role: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = "";
  return url.toString();
}

function databaseUrl(name: string): string {
  const url = new URL(adminUrl ?? "postgres://localhost/postgres");
  url.pathname = `/${name}`;
  return url.toString();
}

/** Copies a database; the source must have no open connections. */
async function copyDatabase(source: string, target: string): Promise<void> {
  const admin = new SQL(adminUrl ?? "");

  try {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${source}' AND pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`CREATE DATABASE "${target}" TEMPLATE "${source}"`);
  } finally {
    await admin.close();
  }
}

async function dropDatabase(name: string): Promise<void> {
  const admin = new SQL(adminUrl ?? "");

  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.close();
  }
}

function storageFor(store = createMemoryStore()) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: createS3Handler({ store, bucket: "bulletin", credentials }),
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const storage = createStorage({ endpoint, bucket: "bulletin", ...credentials });

  return { server, storage };
}

interface Fixture {
  readonly aliceId: string;
  readonly bobId: string;
  readonly adminId: string;
  readonly moderatorId: string;
  readonly staffToken: string;
  readonly bobAttachmentId: string;
  readonly bobAttachmentKey: string;
  readonly requestId: string;
}

async function member(sql: SQL, name: string, groups: readonly string[]): Promise<string> {
  const [row] = (await sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES (${name}, ${name.toLowerCase().replaceAll(" ", "-")})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  for (const [index, key] of groups.entries()) {
    await sql`
      INSERT INTO core.member_groups (member_id, group_id, is_primary)
      SELECT ${row?.id}, id, ${index === 0} FROM core.groups WHERE key = ${key}
    `;
  }

  return row?.id ?? "";
}

/** The board as it is when the nightly backup is taken. */
async function seedBeforeBackup(sql: SQL, storage: StorageClient): Promise<Fixture> {
  const aliceId = await member(sql, "Alice Restore", ["members"]);
  const bobId = await member(sql, "Bob Restore", ["members"]);
  const adminId = await member(sql, "Restore Admin", ["administrators"]);
  const moderatorId = await member(sql, "Restore Moderator", ["members", "super_moderators"]);

  await sql`
    INSERT INTO pii.identities (member_id, issuer, sub, email)
    VALUES (${aliceId}, 'https://auth.test', 'restore-alice', 'alice@example.test')
  `;
  await sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
    VALUES (${aliceId}, 'user', sha256(convert_to('alice-token', 'UTF8')), now() + interval '1 day')
  `;
  await sql`
    INSERT INTO core.api_keys (prefix, hash, principal_member_id, kind, label)
    VALUES ('restorek', sha256(convert_to('restore-key', 'UTF8')), ${aliceId}, 'personal', 'Key')
  `;
  await sql`
    INSERT INTO pii.push_subscriptions (member_id, endpoint, p256dh, auth_secret, label)
    VALUES (${aliceId}, 'https://push.test/alice', 'key', 'auth', 'Phone')
  `;
  // A queued email to Alice: after the restore it must never be delivered.
  await sql`
    INSERT INTO core.notifications (member_id, type) VALUES (${aliceId}, 'topic.reply')
  `;
  await sql`
    INSERT INTO core.delivery_intents (member_id, kind, ref_id, channel)
    SELECT ${aliceId}, 'notification', id, 'email' FROM core.notifications
    WHERE member_id = ${aliceId}
  `;

  const staffToken = "restore-staff-token";
  await sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at, last_auth_at)
    VALUES (
      ${adminId}, 'staff', sha256(convert_to(${staffToken}, 'UTF8')),
      now() + interval '1 day', now()
    )
  `;

  // Bob's attachment row is in the backup; its object will be lost from storage.
  const bobAttachmentKey = `att/${"d".repeat(64)}`;
  const [attachment] = (await sql`
    INSERT INTO core.attachments (
      member_id, state, filename, declared_type, declared_bytes, quarantine_key,
      storage_key, size_bytes, sha256, verified_type
    ) VALUES (
      ${bobId}, 'ready', 'notes.txt', 'text/plain', 5, 'quarantine/bob',
      ${bobAttachmentKey}, 5, ${"d".repeat(64)}, 'text/plain'
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  await storage.put(bobAttachmentKey, "notes", { contentType: "text/plain" });

  // Alice asks to be erased; the request is still pending when the backup is taken.
  const [request] = (await sql`
    INSERT INTO pii.data_requests (member_id, kind, status, post_action)
    VALUES (${aliceId}, 'erasure', 'pending', 'delete')
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  return {
    aliceId,
    bobId,
    adminId,
    moderatorId,
    staffToken,
    bobAttachmentId: attachment?.id ?? "",
    bobAttachmentKey,
    requestId: request?.id ?? "",
  };
}

const pluginErase = async () => ({ ok: true });

integrationDescribe("restore: erasure journal replay and reconciliation", () => {
  let live: TestDatabase;
  const backupName = `bulletin_restore_backup_${crypto.randomUUID().slice(0, 8)}`;
  const restoredName = `bulletin_restore_restored_${crypto.randomUUID().slice(0, 8)}`;
  const { server, storage } = storageFor();
  let fixture: Fixture;

  beforeAll(async () => {
    live = await createTestDatabase({ adminUrl: adminUrl ?? "", prefix: "restore_live" });
    await runSeeds({
      sql: live.sql,
      registry: new SeedRegistry([baseSeedModule, permissionFixtureSeedModule]),
    });
    fixture = await seedBeforeBackup(live.sql, storage);

    const workers = new SQL(roleUrl(live.url, "workers"));
    await writeRestoreWatermark(workers, storage);
    await workers.close();

    // Nightly backup.
    await live.sql.close();
    await copyDatabase(live.name, backupName);

    // After the backup: staff approve the erasure and the job runs to completion.
    const after = new SQL(live.url);
    await after`
      SELECT pii.update_data_request(${fixture.staffToken}, ${fixture.requestId}, 'process', 'Approved')
    `;
    await after.close();
    const afterWorkers = new SQL(roleUrl(live.url, "workers"));
    const erased = await runErasureJob(afterWorkers, storage, fixture.requestId, { pluginErase });
    expect(erased?.journalKey).toMatch(/^journal\/\d{4}-\d{2}-\d{2}\/\d{12}\.json$/);
    await writeRestoreWatermark(afterWorkers, storage);
    await afterWorkers.close();

    // Bob's file is lost, and an orphan appears that no restored row references.
    await storage.delete(fixture.bobAttachmentKey);
    await storage.put(`att/${"e".repeat(64)}`, "orphan");

    // Restore the backup.
    await copyDatabase(backupName, restoredName);
  }, 120_000);

  afterAll(async () => {
    server.stop(true);
    await dropDatabase(restoredName);
    await dropDatabase(backupName);
    await live?.drop();
  });

  test("services stay unready until the erasure is replayed, then nothing reaches the member", async () => {
    const restoredUrl = databaseUrl(restoredName);
    const userApi = new SQL(roleUrl(restoredUrl, "user_api"));
    const workers = new SQL(roleUrl(restoredUrl, "workers"));
    const admin = new SQL(restoredUrl);

    try {
      // The restored database predates the erasure: Alice is back, with her email and devices.
      const [before] = (await admin`
        SELECT state FROM core.members WHERE id = ${fixture.aliceId}
      `) as Array<{ state: string }>;
      expect(before?.state).toBe("active");
      expect(await storage.exists(JOURNAL_HEAD_KEY)).toBe(true);
      expect(await journalApplied(userApi, storage)).toBe(false);
      const readiness = createJournalReadinessCheck(userApi, storage);
      expect(await readiness.check()).toBe(false);
      expect(await detectRestore(workers, storage)).toBe(true);

      const prepared = await prepareAfterRestore({
        sql: workers,
        storage,
        erasure: { pluginErase },
        reconcileGraceMs: 0,
      });
      expect(prepared).toEqual({ restored: true, replayed: 1 });
      expect(await readiness.check()).toBe(true);

      const [after] = (await admin`
        SELECT
          (SELECT state FROM core.members WHERE id = ${fixture.aliceId}) AS state,
          (SELECT count(*)::int FROM pii.identities WHERE member_id = ${fixture.aliceId})
            AS identities,
          (SELECT count(*)::int FROM core.sessions
            WHERE member_id = ${fixture.aliceId} AND revoked_at IS NULL) AS sessions,
          (SELECT count(*)::int FROM core.api_keys
            WHERE principal_member_id = ${fixture.aliceId}) AS api_keys,
          (SELECT count(*)::int FROM pii.push_subscriptions
            WHERE member_id = ${fixture.aliceId}) AS devices,
          (SELECT count(*)::int FROM core.delivery_intents
            WHERE member_id = ${fixture.aliceId}) AS deliveries,
          (SELECT status FROM pii.data_requests WHERE id = ${fixture.requestId}) AS request,
          (SELECT count(*)::int FROM core.erasure_journal_applied WHERE replayed) AS replayed
      `) as Array<Record<string, unknown>>;
      expect(after).toEqual({
        state: "erased",
        identities: 0,
        sessions: 0,
        api_keys: 0,
        devices: 0,
        deliveries: 0,
        request: "completed",
        replayed: 1,
      });

      // Reconciliation removed the orphan, kept Bob's row, and listed his missing file.
      expect(await storage.exists(`att/${"e".repeat(64)}`)).toBe(false);
      const missing = (await admin`
        SELECT kind, resource_id::text AS resource_id, storage_key FROM core.missing_objects
      `) as Array<{ kind: string; resource_id: string; storage_key: string }>;
      expect(missing).toEqual([
        {
          kind: "attachment",
          resource_id: fixture.bobAttachmentId,
          storage_key: fixture.bobAttachmentKey,
        },
      ]);
      const [run] = (await admin`
        SELECT trigger, status, replayed, removed_objects, missing_objects
        FROM core.restore_runs
      `) as Array<Record<string, unknown>>;
      expect(run).toEqual({
        trigger: "detected",
        status: "completed",
        replayed: 1,
        removed_objects: 1,
        missing_objects: 1,
      });

      // A second start is a no-op: nothing to replay, no restore detected.
      expect(
        await prepareAfterRestore({ sql: workers, storage, erasure: { pluginErase } }),
      ).toEqual({ restored: false, replayed: 0 });
    } finally {
      await userApi.close();
      await workers.close();
      await admin.close();
    }
  }, 120_000);

  test("staff with acp.system see the missing file, and its download explains it", async () => {
    const restoredUrl = databaseUrl(restoredName);
    const staffSql = new SQL(roleUrl(restoredUrl, "staff_api"));
    const userApp = new SQL(roleUrl(restoredUrl, "user_app"));
    const route = STAFF_ROUTES.find(
      (candidate) => candidate.id === "system.missingObjects",
    ) as StaffRoute;
    const context = (memberId: string): StaffRouteContext => {
      const url = new URL("http://staff.test/api/staff/system/missing-objects");
      return {
        request: new Request(url),
        url,
        session: { id: "1", memberId, lastAuthAt: new Date() } as unknown as SessionRecord,
        sql: staffSql,
      };
    };

    try {
      const allowed = await authorizeStaffRoute(route, context(fixture.adminId));
      expect(allowed.status).toBe(200);
      const report = (await allowed.json()) as MissingObjectsReport;
      expect(report.total).toBe(1);
      expect(report.items[0]).toMatchObject({
        kind: "attachment",
        resourceId: fixture.bobAttachmentId,
        storageKey: fixture.bobAttachmentKey,
      });
      expect(report.lastRun).toMatchObject({ trigger: "detected", status: "completed" });

      // Permission denial: a super moderator lacks acp.system; a member lacks ACP access.
      for (const denied of [fixture.moderatorId, fixture.bobId]) {
        expect((await authorizeStaffRoute(route, context(denied))).status).toBe(403);
      }

      // Bob previews his own file: authorised, but the object is gone.
      const download = await attachmentDownloadResponse({
        sql: userApp,
        storage,
        session: { memberId: fixture.bobId, sessionId: "1" },
        hasSessionCookie: true,
        id: fixture.bobAttachmentId,
        preview: true,
      });
      expect(download.status).toBe(410);
      expect(await download.json()).toEqual({ code: "attachment_missing" });

      // Recovering the object from its previous version clears the listing on the next scan.
      const versions = await storage.listVersions?.(fixture.bobAttachmentKey);
      const previous = versions?.find((version) => !version.deleteMarker);
      expect(previous).toBeDefined();
      await storage.restoreVersion?.(fixture.bobAttachmentKey, previous?.versionId ?? "");
      const workers = new SQL(roleUrl(restoredUrl, "workers"));
      expect(await scanMissingObjects(workers, storage)).toEqual({ missing: 0, resolved: 1 });
      await workers.close();
    } finally {
      await staffSql.close();
      await userApp.close();
    }
  }, 60_000);

  test("a manual post-restore run is recorded and idempotent", async () => {
    const workers = new SQL(roleUrl(databaseUrl(restoredName), "workers"));

    try {
      const result = await runPostRestore({
        sql: workers,
        storage,
        trigger: "manual",
        erasure: { pluginErase },
      });
      expect(result.replay).toEqual({ replayed: 0, recorded: 0, skipped: [] });
      expect(result.missing).toEqual({ missing: 0, resolved: 0 });
    } finally {
      await workers.close();
    }
  }, 60_000);
});

describe("bucket versioning (35 days)", () => {
  test("a file deleted 3 days ago can be restored; one deleted 36 days ago cannot", async () => {
    let clock = Date.now();
    const { server, storage } = storageFor(createMemoryStore({ now: () => new Date(clock) }));

    try {
      await storage.put("att/recent", "recent", { contentType: "text/plain" });
      await storage.put("att/old", "old", { contentType: "text/plain" });
      clock = Date.now() - 36 * 86_400_000;
      await storage.delete("att/old");
      clock = Date.now() - 3 * 86_400_000;
      await storage.delete("att/recent");
      clock = Date.now();

      expect(await storage.exists("att/recent")).toBe(false);
      const versions = (await storage.listVersions?.("att/")) ?? [];
      expect(
        versions.map((version) => [version.key, version.deleteMarker, version.isLatest]),
      ).toEqual([
        ["att/recent", true, true],
        ["att/recent", false, false],
      ]);

      const previous = versions.find((version) => !version.deleteMarker);
      await storage.restoreVersion?.("att/recent", previous?.versionId ?? "");
      expect(new TextDecoder().decode(await storage.get("att/recent"))).toBe("recent");
    } finally {
      server.stop(true);
    }
  });
});

integrationDescribe("bucket versioning in the Postgres-backed mock", () => {
  test("keeps overwritten and deleted versions until they expire", async () => {
    const database = await createTestDatabase({ adminUrl: adminUrl ?? "", prefix: "s3_versions" });
    const store = await createPostgresStore(database.sql);
    const { server, storage } = storageFor(store);

    try {
      await storage.put("att/file", "first");
      await storage.put("att/file", "second");
      await storage.delete("att/file");
      const versions = (await storage.listVersions?.("att/file")) ?? [];
      expect(
        versions.map((version) => [version.deleteMarker, version.isLatest, version.size]),
      ).toEqual([
        [true, true, 0],
        [false, false, 6],
        [false, false, 5],
      ]);

      await storage.restoreVersion?.("att/file", versions[2]?.versionId ?? "");
      expect(new TextDecoder().decode(await storage.get("att/file"))).toBe("first");

      await database.sql`
        UPDATE mock_s3.object_versions SET noncurrent_at = now() - interval '36 days'
      `;
      expect(
        ((await storage.listVersions?.("att/file")) ?? []).map((version) => version.isLatest),
      ).toEqual([true]);
    } finally {
      server.stop(true);
      await database.drop();
    }
  });
});
