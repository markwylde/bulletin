import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger } from "@bulletin/config";
import { startService } from "@bulletin/config/server";
import {
  detectRestore,
  drainRevocationJournal,
  prepareAfterRestore,
  pruneJournal,
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
  journalApplied,
  listJournalKeys,
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
      expect(await listJournalKeys(storage)).toHaveLength(1);
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
      expect(result.replay).toEqual({ replayed: 0, recorded: 0, revocations: 0, skipped: [] });
      expect(result.missing).toEqual({ missing: 0, resolved: 0 });
    } finally {
      await workers.close();
    }
  }, 60_000);
});

integrationDescribe("restore: several journal entries", () => {
  let live: TestDatabase;
  const backupName = `bulletin_restore_multi_backup_${crypto.randomUUID().slice(0, 8)}`;
  const restoredName = `bulletin_restore_multi_restored_${crypto.randomUUID().slice(0, 8)}`;
  const gateRestoredName = `bulletin_restore_multi_gate_${crypto.randomUUID().slice(0, 8)}`;
  const { server, storage } = storageFor();
  const requests: Array<{ memberId: string; requestId: string; key: string }> = [];

  beforeAll(async () => {
    live = await createTestDatabase({ adminUrl: adminUrl ?? "", prefix: "restore_multi" });
    await runSeeds({
      sql: live.sql,
      registry: new SeedRegistry([baseSeedModule, permissionFixtureSeedModule]),
    });
    const adminId = await member(live.sql, "Multi Admin", ["administrators"]);
    const staffToken = "restore-multi-staff-token";
    await live.sql`
      INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at, last_auth_at)
      VALUES (
        ${adminId}, 'staff', sha256(convert_to(${staffToken}, 'UTF8')),
        now() + interval '1 day', now()
      )
    `;
    // A bystander whose session is restored as well and must keep working after the replay.
    const boId = await member(live.sql, "Bo Multi", ["members"]);
    await live.sql`
      INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
      VALUES (${boId}, 'user', sha256(convert_to('Bo Multi-token', 'UTF8')), now() + interval '1 day')
    `;
    const pending: Array<{ memberId: string; requestId: string }> = [];

    for (const name of ["Ann Multi", "Cy Multi"]) {
      const memberId = await member(live.sql, name, ["members"]);
      await live.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (
          ${memberId}, 'user', sha256(convert_to(${`${name}-token`}, 'UTF8')),
          now() + interval '1 day'
        )
      `;
      const [request] = (await live.sql`
        INSERT INTO pii.data_requests (member_id, kind, status, post_action)
        VALUES (${memberId}, 'erasure', 'pending', 'anonymise')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      pending.push({ memberId, requestId: request?.id ?? "" });
    }

    const workers = new SQL(roleUrl(live.url, "workers"));
    await writeRestoreWatermark(workers, storage);
    await workers.close();
    await live.sql.close();
    await copyDatabase(live.name, backupName);

    // After the backup both erasures complete, oldest first; HEAD names the newest.
    const after = new SQL(live.url);
    const afterWorkers = new SQL(roleUrl(live.url, "workers"));

    for (const entry of pending) {
      await after`
        SELECT pii.update_data_request(${staffToken}, ${entry.requestId}, 'process', 'Approved')
      `;
      const erased = await runErasureJob(afterWorkers, storage, entry.requestId, { pluginErase });
      requests.push({ ...entry, key: erased?.journalKey ?? "" });
    }

    await writeRestoreWatermark(afterWorkers, storage);
    await after.close();
    await afterWorkers.close();
    await copyDatabase(backupName, restoredName);
    await copyDatabase(backupName, gateRestoredName);
  }, 120_000);

  afterAll(async () => {
    server.stop(true);
    await dropDatabase(gateRestoredName);
    await dropDatabase(restoredName);
    await dropDatabase(backupName);
    await live?.drop();
  });

  test("services stay unready until every entry is replayed, not just the first", async () => {
    const restoredUrl = databaseUrl(restoredName);
    const userApi = new SQL(roleUrl(restoredUrl, "user_api"));
    const workers = new SQL(roleUrl(restoredUrl, "workers"));
    const [first, last] = requests;
    const readinessBetween: boolean[] = [];

    // Observe readiness at the moment the second entry is read, i.e. after the first entry's
    // erasure has been replayed in full and before the second one starts.
    const observed: StorageClient = {
      ...storage,
      async get(key) {
        if (key === last?.key) {
          readinessBetween.push(await journalApplied(userApi, storage));
          readinessBetween.push(await createJournalReadinessCheck(userApi, storage).check());
        }

        return storage.get(key);
      },
    };

    try {
      expect(first?.key).not.toBe(last?.key);
      expect(await listJournalKeys(storage)).toEqual([first?.key, last?.key]);
      expect(await journalApplied(userApi, storage)).toBe(false);

      const prepared = await prepareAfterRestore({
        sql: workers,
        storage: observed,
        erasure: { pluginErase },
        reconcileGraceMs: 0,
      });

      expect(prepared).toEqual({ restored: true, replayed: 2 });
      expect(readinessBetween).toEqual([false, false]);
      expect(await journalApplied(userApi, storage)).toBe(true);

      const sessions = (await workers`
        SELECT count(*)::int AS live FROM core.sessions
        WHERE member_id IN (${first?.memberId ?? "0"}, ${last?.memberId ?? "0"})
          AND revoked_at IS NULL
      `) as Array<{ live: number }>;
      expect(sessions[0]?.live).toBe(0);
    } finally {
      await userApi.close();
      await workers.close();
    }
  }, 120_000);

  test("a restored credential gets 503 before the replay and is handled after it", async () => {
    const restoredUrl = databaseUrl(gateRestoredName);
    const userApi = new SQL(roleUrl(restoredUrl, "user_api"));
    const workers = new SQL(roleUrl(restoredUrl, "workers"));
    // A stand-in user-api: the real request gate, and a handler that trusts any live session.
    const service = await startService({
      service: "restore-gate",
      port: 0,
      hostname: "127.0.0.1",
      installSignalHandlers: false,
      logger: createLogger({ service: "restore-gate", sink: () => undefined }),
      requestGates: [createJournalReadinessCheck(userApi, storage)],
      async fetch(request) {
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        const rows = (await userApi`
          SELECT 1 FROM core.sessions
          WHERE token_hash = sha256(convert_to(${token}, 'UTF8')) AND revoked_at IS NULL
        `) as unknown[];

        return rows.length > 0
          ? Response.json({ ok: true })
          : Response.json({ code: "unauthenticated" }, { status: 401 });
      },
    });
    const base = `http://127.0.0.1:${service.server.port}`;
    const call = (token: string) =>
      fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });

    try {
      // Ann was erased after the backup; her restored session is live in the database.
      const erased = await call("Ann Multi-token");
      expect(erased.status).toBe(503);
      expect(erased.headers.get("cache-control")).toBe("no-store");
      expect(erased.headers.get("retry-after")).toBe("30");
      expect((await call("Bo Multi-token")).status).toBe(503);
      expect((await fetch(`${base}/health/live`)).status).toBe(200);

      await prepareAfterRestore({
        sql: workers,
        storage,
        erasure: { pluginErase },
        reconcileGraceMs: 0,
      });

      // The gate rechecks at most once a second.
      await Bun.sleep(1_100);
      expect((await call("Bo Multi-token")).status).toBe(200);
      expect((await call("Ann Multi-token")).status).toBe(401);
    } finally {
      await service.shutdown();
      await userApi.close();
      await workers.close();
    }
  }, 120_000);
});

integrationDescribe("restore: erasures that complete out of order", () => {
  let live: TestDatabase;
  const suffix = crypto.randomUUID().slice(0, 8);
  const backupName = `bulletin_restore_order_backup_${suffix}`;
  const restoredName = `bulletin_restore_order_restored_${suffix}`;
  const { server, storage } = storageFor();
  let earlier = { memberId: "", requestId: "" };

  beforeAll(async () => {
    live = await createTestDatabase({ adminUrl: adminUrl ?? "", prefix: "restore_order" });
    await runSeeds({
      sql: live.sql,
      registry: new SeedRegistry([baseSeedModule, permissionFixtureSeedModule]),
    });
    const adminId = await member(live.sql, "Order Admin", ["administrators"]);
    const staffToken = "restore-order-staff-token";
    await live.sql`
      INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at, last_auth_at)
      VALUES (
        ${adminId}, 'staff', sha256(convert_to(${staffToken}, 'UTF8')),
        now() + interval '1 day', now()
      )
    `;
    const requests: Array<{ memberId: string; requestId: string }> = [];

    for (const name of ["Eve Order", "Fay Order"]) {
      const memberId = await member(live.sql, name, ["members"]);
      await live.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (
          ${memberId}, 'user', sha256(convert_to(${`${name}-token`}, 'UTF8')),
          now() + interval '1 day'
        )
      `;
      const [request] = (await live.sql`
        INSERT INTO pii.data_requests (member_id, kind, status, post_action)
        VALUES (${memberId}, 'erasure', 'pending', 'anonymise')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      await live.sql`
        SELECT pii.update_data_request(${staffToken}, ${request?.id ?? "0"}, 'process', 'Approved')
      `;
      requests.push({ memberId, requestId: request?.id ?? "" });
    }

    const [first, second] = requests as [typeof earlier, typeof earlier];
    earlier = first;
    const workers = new SQL(roleUrl(live.url, "workers"));

    // Request 2 completes before the backup.
    await runErasureJob(workers, storage, second.requestId, { pluginErase });
    await writeRestoreWatermark(workers, storage);
    await workers.close();
    await live.sql.close();
    await copyDatabase(live.name, backupName);

    // Request 1, accepted earlier, completes only after the backup.
    const after = new SQL(roleUrl(live.url, "workers"));
    await runErasureJob(after, storage, first.requestId, { pluginErase });
    await after.close();
    await copyDatabase(backupName, restoredName);
  }, 120_000);

  afterAll(async () => {
    server.stop(true);
    await dropDatabase(restoredName);
    await dropDatabase(backupName);
    await live?.drop();
  });

  test("an earlier request completed after the backup keeps services unready until replayed", async () => {
    const restoredUrl = databaseUrl(restoredName);
    const userApi = new SQL(roleUrl(restoredUrl, "user_api"));
    const workers = new SQL(roleUrl(restoredUrl, "workers"));

    try {
      expect(await journalApplied(userApi, storage)).toBe(false);
      expect(await createJournalReadinessCheck(userApi, storage).check()).toBe(false);

      await prepareAfterRestore({ sql: workers, storage, erasure: { pluginErase } });

      expect(await journalApplied(userApi, storage)).toBe(true);
      const [row] = (await workers`
        SELECT count(*)::int AS live FROM core.sessions
        WHERE member_id = ${earlier.memberId} AND revoked_at IS NULL
      `) as Array<{ live: number }>;
      expect(row?.live).toBe(0);
    } finally {
      await userApi.close();
      await workers.close();
    }
  }, 120_000);
});

integrationDescribe("restore: standalone revocations", () => {
  let live: TestDatabase;
  const suffix = crypto.randomUUID().slice(0, 8);
  const backupName = `bulletin_restore_revoke_backup_${suffix}`;
  const restoredName = `bulletin_restore_revoke_restored_${suffix}`;
  const { server, storage } = storageFor();
  const ids: Record<string, string> = {};

  async function insertSession(sql: SQL, memberId: string, token: string): Promise<string> {
    const [row] = (await sql`
      INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
      VALUES (${memberId}, 'user', sha256(convert_to(${token}, 'UTF8')), now() + interval '1 day')
      RETURNING id::text AS id
    `) as Array<{ id: string }>;
    return row?.id ?? "";
  }

  async function insertKey(sql: SQL, memberId: string, prefix: string): Promise<string> {
    const [row] = (await sql`
      INSERT INTO core.api_keys (prefix, hash, principal_member_id, kind, label)
      VALUES (${prefix}, sha256(convert_to(${prefix}, 'UTF8')), ${memberId}, 'personal', 'Key')
      RETURNING id::text AS id
    `) as Array<{ id: string }>;
    return row?.id ?? "";
  }

  async function insertDevice(sql: SQL, memberId: string, endpoint: string): Promise<string> {
    const [row] = (await sql`
      INSERT INTO pii.push_subscriptions (member_id, endpoint, p256dh, auth_secret, label)
      VALUES (${memberId}, ${endpoint}, 'key', 'auth', 'Phone')
      RETURNING id::text AS id
    `) as Array<{ id: string }>;
    return row?.id ?? "";
  }

  beforeAll(async () => {
    live = await createTestDatabase({ adminUrl: adminUrl ?? "", prefix: "restore_revoke" });
    await runSeeds({
      sql: live.sql,
      registry: new SeedRegistry([baseSeedModule, permissionFixtureSeedModule]),
    });
    const gus = await member(live.sql, "Gus Revoke", ["members"]);
    const hal = await member(live.sql, "Hal Revoke", ["members"]);
    ids.loggedOut = await insertSession(live.sql, gus, "gus-logged-out");
    ids.deletedSession = await insertSession(live.sql, gus, "gus-deleted");
    ids.keptSession = await insertSession(live.sql, gus, "gus-kept");
    ids.revokedKey = await insertKey(live.sql, gus, "gusrevok");
    ids.deletedKey = await insertKey(live.sql, gus, "gusdelet");
    ids.removedDevice = await insertDevice(live.sql, gus, "https://push.test/gus-removed");
    ids.movedDevice = await insertDevice(live.sql, gus, "https://push.test/gus-moved");
    ids.hal = hal;

    const workers = new SQL(roleUrl(live.url, "workers"));
    await writeRestoreWatermark(workers, storage);
    await workers.close();
    await live.sql.close();
    await copyDatabase(live.name, backupName);

    // After the backup, through whatever code path: a logout, a deleted session, a revoked and
    // a deleted API key, a removed device and an endpoint re-assigned to another member.
    const userApi = new SQL(roleUrl(live.url, "user_api"));
    await userApi`UPDATE core.sessions SET revoked_at = now() WHERE id = ${ids.loggedOut}`;
    await userApi`DELETE FROM core.sessions WHERE id = ${ids.deletedSession}`;
    await userApi`UPDATE core.api_keys SET revoked_at = now() WHERE id = ${ids.revokedKey}`;
    await userApi`DELETE FROM core.api_keys WHERE id = ${ids.deletedKey}`;
    await userApi.close();
    const admin = new SQL(live.url);
    await admin`DELETE FROM pii.push_subscriptions WHERE id = ${ids.removedDevice}`;
    await admin`UPDATE pii.push_subscriptions SET member_id = ${hal} WHERE id = ${ids.movedDevice}`;
    await admin.close();

    const afterWorkers = new SQL(roleUrl(live.url, "workers"));
    expect(await drainRevocationJournal(afterWorkers, storage)).toBe(6);
    expect(await drainRevocationJournal(afterWorkers, storage)).toBe(0);
    await afterWorkers.close();
    await copyDatabase(backupName, restoredName);
  }, 120_000);

  afterAll(async () => {
    server.stop(true);
    await dropDatabase(restoredName);
    await dropDatabase(backupName);
    await live?.drop();
  });

  test("the journal entry holds IDs only", async () => {
    const keys = await listJournalKeys(storage);
    expect(keys).toHaveLength(1);
    const entry = JSON.parse(new TextDecoder().decode(await storage.get(keys[0] ?? ""))) as Record<
      string,
      unknown
    >;
    expect(Object.keys(entry).sort()).toEqual([
      "apiKeyIds",
      "kind",
      "pushDeviceIds",
      "sessionIds",
      "writtenAt",
    ]);
    expect(entry.kind).toBe("revocations");
    expect(entry.sessionIds).toEqual([ids.loggedOut, ids.deletedSession]);
    expect(entry.apiKeyIds).toEqual([ids.revokedKey, ids.deletedKey]);
    expect(entry.pushDeviceIds).toEqual([ids.removedDevice, ids.movedDevice]);
  });

  test("revoked sessions, API keys and removed devices stay unusable after restore and replay", async () => {
    const restoredUrl = databaseUrl(restoredName);
    const userApi = new SQL(roleUrl(restoredUrl, "user_api"));
    const workers = new SQL(roleUrl(restoredUrl, "workers"));
    const admin = new SQL(restoredUrl);
    const usable = async () =>
      (await admin`
        SELECT
          (SELECT array_agg(id::text ORDER BY id) FROM core.sessions
            WHERE id IN (${ids.loggedOut}, ${ids.deletedSession}, ${ids.keptSession})
              AND revoked_at IS NULL) AS sessions,
          (SELECT array_agg(id::text ORDER BY id) FROM core.api_keys
            WHERE id IN (${ids.revokedKey}, ${ids.deletedKey}) AND revoked_at IS NULL) AS keys,
          (SELECT array_agg(id::text ORDER BY id) FROM pii.push_subscriptions
            WHERE id IN (${ids.removedDevice}, ${ids.movedDevice})) AS devices
      `) as Array<{ sessions: string[] | null; keys: string[] | null; devices: string[] | null }>;

    try {
      // The backup predates every revocation: all of them are live again.
      expect((await usable())[0]?.sessions).toHaveLength(3);
      expect(await journalApplied(userApi, storage)).toBe(false);

      await prepareAfterRestore({ sql: workers, storage, erasure: { pluginErase } });

      expect(await journalApplied(userApi, storage)).toBe(true);
      expect((await usable())[0]).toEqual({
        sessions: [ids.keptSession],
        keys: null,
        devices: null,
      });

      // Entries older than the 35-day recovery window are pruned with their applied rows.
      expect(await pruneJournal(workers, storage)).toBe(0);
      expect(
        await pruneJournal(workers, storage, { now: new Date(Date.now() + 37 * 86_400_000) }),
      ).toBe(1);
      expect(await listJournalKeys(storage)).toEqual([]);
      const [left] = (await workers`
        SELECT count(*)::int AS applied FROM core.erasure_journal_applied
      `) as Array<{ applied: number }>;
      expect(left?.applied).toBe(0);
    } finally {
      await userApi.close();
      await workers.close();
      await admin.close();
    }
  }, 120_000);
});

integrationDescribe("restore: backup taken after the latest watermark", () => {
  let live: TestDatabase;
  const suffix = crypto.randomUUID().slice(0, 8);
  const equalBackup = `bulletin_restore_equal_backup_${suffix}`;
  const higherBackup = `bulletin_restore_higher_backup_${suffix}`;
  const equalRestored = `bulletin_restore_equal_restored_${suffix}`;
  const higherRestored = `bulletin_restore_higher_restored_${suffix}`;
  const { server, storage } = storageFor();
  const lostKey = `att/${"a".repeat(64)}`;
  const orphanKey = `att/${"b".repeat(64)}`;
  let attachmentId = "";

  beforeAll(async () => {
    live = await createTestDatabase({ adminUrl: adminUrl ?? "", prefix: "restore_marker" });
    await runSeeds({
      sql: live.sql,
      registry: new SeedRegistry([baseSeedModule, permissionFixtureSeedModule]),
    });
    const ownerId = await member(live.sql, "Dee Marker", ["members"]);
    const [attachment] = (await live.sql`
      INSERT INTO core.attachments (
        member_id, state, filename, declared_type, declared_bytes, quarantine_key,
        storage_key, size_bytes, sha256, verified_type
      ) VALUES (
        ${ownerId}, 'ready', 'plan.txt', 'text/plain', 4, 'quarantine/dee',
        ${lostKey}, 4, ${"a".repeat(64)}, 'text/plain'
      )
      RETURNING id::text AS id
    `) as Array<{ id: string }>;
    attachmentId = attachment?.id ?? "";
    await storage.put(lostKey, "plan", { contentType: "text/plain" });
    await live.sql`SELECT nextval('core.events_id_seq')`;

    // The workers' latest minute watermark, then a backup at exactly that sequence.
    const workers = new SQL(roleUrl(live.url, "workers"));
    await writeRestoreWatermark(workers, storage);
    await workers.close();
    await live.sql.close();
    await copyDatabase(live.name, equalBackup);

    // Some writes later, still before the next watermark, a second backup.
    const later = new SQL(live.url);
    await later`SELECT nextval('core.events_id_seq')`;
    await later`SELECT nextval('core.events_id_seq')`;
    await later.close();
    await copyDatabase(live.name, higherBackup);

    // After both backups: the file is lost and an upload no restored row references appears.
    await storage.delete(lostKey);
    await storage.put(orphanKey, "orphan");
    await copyDatabase(equalBackup, equalRestored);
    await copyDatabase(higherBackup, higherRestored);
  }, 120_000);

  afterAll(async () => {
    server.stop(true);

    for (const name of [equalRestored, higherRestored, equalBackup, higherBackup]) {
      await dropDatabase(name);
    }

    await live?.drop();
  });

  for (const [label, name] of [
    ["equal to", () => equalRestored],
    ["ahead of", () => higherRestored],
  ] as const) {
    test(`reconciles and lists missing files when the sequence is ${label} the watermark`, async () => {
      await storage.put(orphanKey, "orphan");
      const restoredUrl = databaseUrl(name());
      const workers = new SQL(roleUrl(restoredUrl, "workers"));

      try {
        expect(await detectRestore(workers, storage)).toBe(false);
        await prepareAfterRestore({
          sql: workers,
          storage,
          erasure: { pluginErase },
          reconcileGraceMs: 0,
        });

        expect(await storage.exists(orphanKey)).toBe(false);
        const missing = (await workers`
          SELECT kind, resource_id::text AS resource_id, storage_key FROM core.missing_objects
        `) as Array<Record<string, string>>;
        expect(missing).toEqual([
          { kind: "attachment", resource_id: attachmentId, storage_key: lostKey },
        ]);
      } finally {
        await workers.close();
      }
    }, 60_000);
  }
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
