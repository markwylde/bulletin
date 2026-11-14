import { describe, expect, test } from "bun:test";
import {
  createRetentionJobs,
  RETENTION_CRON,
  RETENTION_QUEUE,
  runRetention,
} from "@bulletin/db/jobs";
import { banIp, listIpBans } from "@bulletin/domain/bans";
import { readPrivacySettings } from "@bulletin/domain/privacy";
import type { StorageClient } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";
import type { PgBoss } from "pg-boss";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(
  prefix: string,
  run: (database: TestDatabase) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix }, run);
}

function recordingStorage(): {
  readonly storage: StorageClient;
  readonly deleted: string[];
  readonly failing: Set<string>;
} {
  const deleted: string[] = [];
  const failing = new Set<string>();

  return {
    deleted,
    failing,
    storage: {
      async put() {
        return 0;
      },
      async get() {
        return new Uint8Array();
      },
      async exists() {
        return false;
      },
      async stat() {
        return { size: 0, contentType: "application/octet-stream", etag: "" };
      },
      async delete(key: string) {
        if (failing.has(key)) {
          throw new Error("storage unavailable");
        }
        deleted.push(key);
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

interface Fixtures {
  readonly memberId: string;
  readonly postId: string;
  readonly freshPostId: string;
  readonly exportRequestId: string;
  readonly freshExportRequestId: string;
  readonly oldExportKey: string;
  readonly freshExportKey: string;
}

async function createFixtures(database: TestDatabase, now: Date): Promise<Fixtures> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name) VALUES ('Retention Member') RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const [forum] = (await database.sql`
    INSERT INTO core.forums (type, title, slug) VALUES ('forum', 'Retention Forum', 'retention-forum')
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const [topic] = (await database.sql`
    INSERT INTO core.topics (forum_id, title, slug, starter_id)
    VALUES (${forum?.id}, 'Retention topic', 'retention-topic', ${member?.id})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const posts = (await database.sql`
    INSERT INTO core.posts (
      topic_id, author_id, body_md, body_html, body_text, render_version,
      sanitiser_version, position
    )
    VALUES
      (${topic?.id}, ${member?.id}, 'Old body', '<p>Old body</p>', 'Old body', 1, 1, 1),
      (${topic?.id}, ${member?.id}, 'Fresh body', '<p>Fresh body</p>', 'Fresh body', 1, 1, 2)
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (member === undefined || posts.length !== 2) {
    throw new Error("Could not create retention fixtures");
  }

  const [oldExport] = (await database.sql`
    INSERT INTO pii.data_requests (
      member_id, kind, status, export_key, export_expires_at, completed_at
    )
    VALUES (
      ${member.id}, 'export', 'completed', 'export/old.zip',
      ${new Date(now.getTime() - 24 * 60 * 60 * 1_000)}, now()
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const [freshExport] = (await database.sql`
    INSERT INTO pii.data_requests (
      member_id, kind, status, export_key, export_expires_at, completed_at
    )
    VALUES (
      ${member.id}, 'export', 'completed', 'export/fresh.zip',
      ${new Date(now.getTime() + 24 * 60 * 60 * 1_000)}, now()
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (oldExport === undefined || freshExport === undefined) {
    throw new Error("Could not create export fixtures");
  }

  return {
    memberId: member.id,
    postId: posts[0]?.id ?? "",
    freshPostId: posts[1]?.id ?? "",
    exportRequestId: oldExport.id,
    freshExportRequestId: freshExport.id,
    oldExportKey: "export/old.zip",
    freshExportKey: "export/fresh.zip",
  };
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1_000);
}

integrationDescribe("retention sweep", () => {
  test("purges every expired category and keeps fresh rows", async () => {
    await withDb("retention_categories", async (database) => {
      const now = new Date();
      const fixtures = await createFixtures(database, now);
      const storage = recordingStorage();

      const [oldSession] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at, revoked_at)
        VALUES (
          ${fixtures.memberId}, 'user', decode(md5(random()::text), 'hex'),
          now() + interval '1 day', ${daysAgo(now, 8)}
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const [freshSession] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at, revoked_at)
        VALUES (
          ${fixtures.memberId}, 'user', decode(md5(random()::text), 'hex'),
          now() + interval '1 day', ${daysAgo(now, 6)}
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const [activeSession] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at, created_at)
        VALUES (
          ${fixtures.memberId}, 'user', decode(md5(random()::text), 'hex'),
          now() + interval '1 day', ${daysAgo(now, 100)}
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const [oldMetaSession] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (
          ${fixtures.memberId}, 'user', decode(md5(random()::text), 'hex'), now() + interval '1 day'
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (
        oldSession === undefined ||
        freshSession === undefined ||
        activeSession === undefined ||
        oldMetaSession === undefined
      ) {
        throw new Error("Could not create session fixtures");
      }

      await database.sql`
        INSERT INTO pii.session_meta (session_id, ip, updated_at)
        VALUES
          (${oldMetaSession.id}, '198.51.100.1', ${daysAgo(now, 31)}),
          (${freshSession.id}, '198.51.100.2', ${daysAgo(now, 29)})
      `;
      await database.sql`
        INSERT INTO pii.ip_log (member_id, ip, created_at)
        VALUES
          (${fixtures.memberId}, '198.51.100.3', ${daysAgo(now, 91)}),
          (${fixtures.memberId}, '198.51.100.4', ${daysAgo(now, 89)})
      `;
      await database.sql`
        INSERT INTO pii.post_ips (post_id, member_id, ip, created_at)
        VALUES
          (${fixtures.postId}, ${fixtures.memberId}, '198.51.100.5', ${daysAgo(now, 91)}),
          (${fixtures.freshPostId}, ${fixtures.memberId}, '198.51.100.6', ${daysAgo(now, 89)})
      `;
      await database.sql`
        INSERT INTO pii.access_log (
          actor_member_id, subject_member_id, purpose, resource_type, created_at
        )
        VALUES
          (${fixtures.memberId}, ${fixtures.memberId}, 'own_data', 'test', ${daysAgo(now, 731)}),
          (${fixtures.memberId}, ${fixtures.memberId}, 'own_data', 'test', ${daysAgo(now, 729)})
      `;
      await database.sql`
        INSERT INTO core.ip_bans (cidr, reason, expires_at)
        VALUES
          ('203.0.113.0/24', 'Expired', ${daysAgo(now, 1)}),
          ('203.0.114.0/24', 'Active', ${new Date(now.getTime() + 24 * 60 * 60 * 1_000)})
      `;

      const result = await runRetention(database.sql, storage.storage, { now });

      expect(result).toEqual({
        postIps: 1,
        loginIps: 1,
        accessLog: 1,
        sessionMeta: 1,
        revokedSessions: 1,
        ipBans: 1,
        exportsDeleted: 1,
        exportFailures: 0,
        dataRequests: 0,
      });
      expect(storage.deleted).toEqual([fixtures.oldExportKey]);

      const sessions = (await database.sql`
        SELECT id::text AS id FROM core.sessions ORDER BY id
      `) as Array<{ id: string }>;
      expect(sessions.map((row) => row.id).sort()).toEqual(
        [freshSession.id, activeSession.id, oldMetaSession.id].sort(),
      );

      const [meta] = (await database.sql`
        SELECT session_id::text AS session_id FROM pii.session_meta ORDER BY session_id
      `) as Array<{ session_id: string }>;
      expect(meta?.session_id).toBe(freshSession.id);

      const ipLogs = (await database.sql`
        SELECT host(ip) AS ip FROM pii.ip_log ORDER BY ip
      `) as Array<{ ip: string }>;
      expect(ipLogs.map((row) => row.ip)).toEqual(["198.51.100.4"]);

      const postIps = (await database.sql`
        SELECT host(ip) AS ip FROM pii.post_ips ORDER BY ip
      `) as Array<{ ip: string }>;
      expect(postIps.map((row) => row.ip)).toEqual(["198.51.100.6"]);

      const audits = (await database.sql`
        SELECT resource_type FROM pii.access_log ORDER BY id
      `) as Array<{ resource_type: string }>;
      expect(audits.map((row) => row.resource_type)).toEqual(["test"]);

      const bans = (await database.sql`
        SELECT host(cidr) || '/' || masklen(cidr) AS cidr FROM core.ip_bans
      `) as Array<{ cidr: string }>;
      expect(bans.map((row) => row.cidr)).toEqual(["203.0.114.0/24"]);

      const exports = (await database.sql`
        SELECT id::text AS id, export_key FROM pii.data_requests ORDER BY id
      `) as Array<{ id: string; export_key: string | null }>;
      expect(exports).toEqual([
        { id: fixtures.exportRequestId, export_key: null },
        { id: fixtures.freshExportRequestId, export_key: fixtures.freshExportKey },
      ]);
    });
  }, 60_000);

  test("honours a changed setting and leaves a failed export for the next run", async () => {
    await withDb("retention_settings", async (database) => {
      const now = new Date();
      const fixtures = await createFixtures(database, now);
      const storage = recordingStorage();
      storage.failing.add(fixtures.oldExportKey);

      await database.sql`
        UPDATE core.privacy_settings
        SET access_log_retention_days = 1
        WHERE id = 1
      `;
      expect((await readPrivacySettings(database.sql)).accessLogDays).toBe(1);

      await database.sql`
        INSERT INTO pii.access_log (
          actor_member_id, subject_member_id, purpose, resource_type, created_at
        )
        VALUES (
          ${fixtures.memberId}, ${fixtures.memberId}, 'own_data', 'changed', ${daysAgo(now, 2)}
        )
      `;

      const failed = await runRetention(database.sql, storage.storage, { now });
      expect(failed.exportFailures).toBe(1);
      expect(failed.exportsDeleted).toBe(0);
      expect(failed.accessLog).toBe(1);

      const [stillThere] = (await database.sql`
        SELECT export_key FROM pii.data_requests WHERE id = ${fixtures.exportRequestId}
      `) as Array<{ export_key: string | null }>;
      expect(stillThere?.export_key).toBe(fixtures.oldExportKey);

      // The next run can delete the object and clear the metadata.
      storage.failing.clear();
      const retried = await runRetention(database.sql, storage.storage, { now });
      expect(retried.exportsDeleted).toBe(1);
      expect(storage.deleted).toContain(fixtures.oldExportKey);

      const [cleared] = (await database.sql`
        SELECT export_key FROM pii.data_requests WHERE id = ${fixtures.exportRequestId}
      `) as Array<{ export_key: string | null }>;
      expect(cleared?.export_key).toBeNull();
    });
  }, 60_000);

  test("uses archive expiry and the two-year completion boundary", async () => {
    await withDb("retention_boundaries", async (database) => {
      const now = new Date();
      const storage = recordingStorage();
      const [member] = (await database.sql`
        INSERT INTO core.members (display_name) VALUES ('Retention Boundary')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (member === undefined) {
        throw new Error("Could not create the retention member");
      }

      const [delayed] = (await database.sql`
        INSERT INTO pii.data_requests (
          member_id, kind, status, export_key, export_expires_at, created_at, completed_at
        ) VALUES (
          ${member.id}, 'export', 'completed', 'export/delayed.zip',
          ${new Date(now.getTime() + 24 * 60 * 60 * 1_000)}, ${daysAgo(now, 60)},
          ${daysAgo(now, 59)}
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const [oldCompleted] = (await database.sql`
        INSERT INTO pii.data_requests (
          member_id, kind, status, created_at, completed_at
        ) VALUES (
          ${member.id}, 'export', 'completed', ${daysAgo(now, 800)}, ${daysAgo(now, 731)}
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const [recentCompleted] = (await database.sql`
        INSERT INTO pii.data_requests (
          member_id, kind, status, created_at, completed_at
        ) VALUES (
          ${member.id}, 'erasure', 'rejected', ${daysAgo(now, 800)}, ${daysAgo(now, 729)}
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const [oldPending] = (await database.sql`
        INSERT INTO pii.data_requests (member_id, kind, status, created_at, due_at)
        VALUES (
          ${member.id}, 'erasure', 'pending', ${daysAgo(now, 800)},
          ${daysAgo(now, 770)}
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (
        delayed === undefined ||
        oldCompleted === undefined ||
        recentCompleted === undefined ||
        oldPending === undefined
      ) {
        throw new Error("Could not create retention requests");
      }

      await database.sql`
        INSERT INTO pii.data_request_steps (request_id, step, state)
        VALUES (${oldCompleted.id}, 'old', 'completed')
      `;

      const result = await runRetention(database.sql, storage.storage, { now });

      expect(result.exportsDeleted).toBe(0);
      expect(result.dataRequests).toBe(1);
      expect(storage.deleted).toEqual([]);
      const rows = (await database.sql`
        SELECT id::text AS id FROM pii.data_requests ORDER BY id
      `) as Array<{ id: string }>;
      expect(rows.map((row) => row.id).sort()).toEqual(
        [delayed.id, recentCompleted.id, oldPending.id].sort(),
      );
      const [steps] = (await database.sql`
        SELECT count(*)::int AS count FROM pii.data_request_steps WHERE request_id = ${oldCompleted.id}
      `) as Array<{ count: number }>;
      expect(steps?.count).toBe(0);
    });
  }, 60_000);

  test("runs as the worker role", async () => {
    await withDb("retention_worker", async (database) => {
      const now = new Date();
      const fixtures = await createFixtures(database, now);
      const storage = recordingStorage();
      const url = new URL(database.url);
      url.username = "workers";
      url.password = "";
      const worker = new SQL(url.toString());

      await database.sql`
        INSERT INTO pii.ip_log (member_id, ip, created_at)
        VALUES (${fixtures.memberId}, '198.51.100.9', ${daysAgo(now, 91)})
      `;

      try {
        const result = await runRetention(worker, storage.storage, { now });
        expect(result.loginIps).toBe(1);
        expect(result.exportsDeleted).toBe(1);
      } finally {
        await worker.close();
      }
    });
  }, 60_000);

  test("uses the configured IP ban duration when the caller gives none", async () => {
    await withDb("retention_ban_duration", async (database) => {
      const [admin] = (await database.sql`
        INSERT INTO core.members (display_name) VALUES ('Retention Admin') RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (admin === undefined) {
        throw new Error("Could not create the admin");
      }

      await database.sql`
        INSERT INTO core.member_groups (member_id, group_id, is_primary)
        SELECT ${admin.id}, id, true FROM core.groups WHERE key = 'administrators'
      `;
      await database.sql`
        UPDATE core.privacy_settings SET ip_ban_retention_days = 30 WHERE id = 1
      `;

      const result = await banIp(database.sql, {
        actorId: admin.id,
        cidr: "198.18.0.0/24",
        reason: "Configured duration",
      });
      expect(result.ok).toBe(true);

      const [ban] = await listIpBans(database.sql);
      expect(ban?.expiresAt).not.toBeNull();

      const days =
        ban?.expiresAt === null || ban?.expiresAt === undefined
          ? 0
          : Math.round((ban.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1_000));
      expect(days).toBe(30);
    });
  }, 30_000);

  test("registers the nightly pg-boss schedule", async () => {
    await withDb("retention_jobs", async (database) => {
      const calls: string[] = [];
      let handler: (() => Promise<void>) | null = null;
      const boss = {
        getQueue: async () => ({}),
        updateQueue: async (name: string) => {
          calls.push(`update:${name}`);
        },
        createQueue: async (name: string) => {
          calls.push(`create:${name}`);
        },
        work: async (name: string, work: () => Promise<void>) => {
          calls.push(`work:${name}`);
          handler = work;
        },
        schedule: async (name: string, cron: string) => {
          calls.push(`schedule:${name}:${cron}`);
        },
        offWork: async (name: string) => {
          calls.push(`off:${name}`);
        },
      } as unknown as PgBoss;
      const storage = recordingStorage();
      const jobs = await createRetentionJobs({
        boss,
        sql: database.sql,
        storage: storage.storage,
      });

      expect(calls).toContain(`work:${RETENTION_QUEUE}`);
      expect(calls).toContain(`schedule:${RETENTION_QUEUE}:${RETENTION_CRON}`);
      expect(RETENTION_CRON).toBe("17 3 * * *");

      const now = new Date();
      const fixtures = await createFixtures(database, now);
      await database.sql`
        INSERT INTO pii.ip_log (member_id, ip, created_at)
        VALUES (${fixtures.memberId}, '198.51.100.10', ${daysAgo(now, 91)})
      `;

      if (handler === null) {
        throw new Error("retention handler was not registered");
      }

      await handler();
      await jobs.stop();
      expect(calls).toContain(`off:${RETENTION_QUEUE}`);

      const [count] = (await database.sql`
        SELECT count(*)::int AS count FROM pii.ip_log
      `) as Array<{ count: number }>;
      // The handler used the real clock: the 2026 fixture is safely in the past.
      expect(count?.count).toBe(0);
    });
  }, 60_000);
});
