import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPgBossQueue,
  createRelay,
  loadMigrations,
  MigrationError,
  runMigrations,
} from "@bulletin/db";
import {
  createEventWorker,
  type EventSubscriber,
  emit,
  isStaleEvent,
  type JobQueue,
} from "@bulletin/db/events";
import { baseSeedModule, runSeeds, type SeedModule, SeedRegistry } from "@bulletin/db/seed";
import { SQL } from "bun";

// Requires a Postgres server with the TEST_DATABASE_URL env var pointing at a maintenance
// database. It is not the compose database because the suite creates and drops databases.
// Example:
//   TEST_DATABASE_URL=postgres://bulletin:bulletin@127.0.0.1:55432/postgres bun test tests/integration/database.test.ts

const adminUrl = Bun.env.TEST_DATABASE_URL;
const enabled = adminUrl !== undefined;
const integrationDescribe = enabled ? describe : describe.skip;

async function withDatabase(run: (databaseUrl: string) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  const admin = new SQL(adminUrl);
  const name = `bulletin_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${name}`;

  await admin.unsafe(`CREATE DATABASE "${name}"`);

  try {
    await run(databaseUrl.toString());
  } finally {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.close();
  }
}

async function schema(sql: SQL): Promise<{ coreOwner: string | null; piiOwner: string | null }> {
  const rows = (await sql`
    SELECT nspname, pg_get_userbyid(nspowner) AS owner
    FROM pg_namespace
    WHERE nspname IN ('core', 'pii')
  `) as Array<{ nspname: string; owner: string }>;

  return {
    coreOwner: rows.find((row) => row.nspname === "core")?.owner ?? null,
    piiOwner: rows.find((row) => row.nspname === "pii")?.owner ?? null,
  };
}

function postCreated(version = 1n) {
  return {
    type: "post.created" as const,
    aggregateId: 10n,
    aggregateVersion: version,
    payloadIds: {
      postId: 100n,
      topicId: 20n,
      forumId: 3n,
      authorId: 7n,
    },
  };
}

class RecordingQueue implements JobQueue {
  readonly jobs: Array<{
    readonly queue: string;
    readonly payload: Record<string, string>;
    readonly singletonKey: string;
  }> = [];
  readonly failFor = new Set<string>();
  failAfterRecord = false;
  failAll = false;

  async send(
    queue: string,
    payload: Readonly<Record<string, string>>,
    options: { readonly singletonKey: string },
  ): Promise<void> {
    if (this.failAll || this.failFor.has(payload.subscriber ?? "")) {
      throw new Error("queue unavailable");
    }

    this.jobs.push({ queue, payload: { ...payload }, singletonKey: options.singletonKey });

    if (this.failAfterRecord) {
      throw new Error("queue crashed after recording");
    }
  }
}

const subscribers: EventSubscriber[] = [
  { name: "core", types: "*" },
  { name: "webhook", types: ["post.created"] },
];

integrationDescribe("database lifecycle", () => {
  test("migrations apply exactly once under concurrent starts", async () => {
    await withDatabase(async (databaseUrl) => {
      const migrations = await loadMigrations();
      const [first, second] = await Promise.all([
        runMigrations({ databaseUrl }),
        runMigrations({ databaseUrl }),
      ]);

      const applied = new Set([...first.applied, ...second.applied]);
      expect(applied.size).toBe(migrations.length);

      const sql = new SQL(databaseUrl);
      const [{ count }] = (await sql`
        SELECT count(*)::int AS count FROM core.schema_migrations
      `) as Array<{ count: number }>;
      expect(count).toBe(migrations.length);
      await sql.close();
    });
  });

  test("an edited applied migration fails with its name and checksums", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bulletin-migrations-"));

    try {
      const file = join(directory, "0001_test.sql");
      await writeFile(
        file,
        "CREATE SCHEMA IF NOT EXISTS core; CREATE TABLE IF NOT EXISTS core.schema_migrations (name text primary key, sha256 text not null, applied_at timestamptz not null default now());",
        "utf8",
      );

      await withDatabase(async (databaseUrl) => {
        await runMigrations({ databaseUrl, migrationsDir: directory });
        const original = await readFile(file, "utf8");
        await writeFile(file, `${original}\n-- edited`, "utf8");

        await expect(
          runMigrations({ databaseUrl, migrationsDir: directory }),
        ).rejects.toBeInstanceOf(MigrationError);

        await expect(runMigrations({ databaseUrl, migrationsDir: directory })).rejects.toThrow(
          /0001_test\.sql/,
        );
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("creates owners, login roles and denies pii privileges", async () => {
    await withDatabase(async (databaseUrl) => {
      await runMigrations({ databaseUrl });
      const sql = new SQL(databaseUrl);

      const owners = await schema(sql);
      expect(owners).toEqual({ coreOwner: "bulletin_owner", piiOwner: "pii_owner" });

      const roles = (await sql`
        SELECT rolname, rolcanlogin
        FROM pg_roles
        WHERE rolname IN ('bulletin_owner', 'pii_owner', 'user_app', 'user_api', 'staff_api', 'workers')
        ORDER BY rolname
      `) as Array<{ rolname: string; rolcanlogin: boolean }>;

      expect(roles).toEqual([
        { rolname: "bulletin_owner", rolcanlogin: false },
        { rolname: "pii_owner", rolcanlogin: false },
        { rolname: "staff_api", rolcanlogin: true },
        { rolname: "user_api", rolcanlogin: true },
        { rolname: "user_app", rolcanlogin: true },
        { rolname: "workers", rolcanlogin: true },
      ]);

      const [privileges] = (await sql`
        SELECT
          has_schema_privilege('user_app', 'core', 'USAGE') AS app_core,
          has_schema_privilege('user_app', 'pii', 'USAGE') AS app_pii,
          has_schema_privilege('user_api', 'pii', 'USAGE') AS api_pii,
          has_table_privilege('user_app', 'core.cache_tags', 'SELECT') AS app_tags_select,
          has_table_privilege('user_app', 'core.cache_tags', 'INSERT') AS app_tags_insert,
          has_table_privilege('user_app', 'core.schema_migrations', 'SELECT') AS app_migrations_select,
          has_table_privilege('user_api', 'core.events', 'INSERT') AS api_events_insert,
          has_table_privilege('workers', 'core.events', 'UPDATE') AS workers_events_update,
          has_table_privilege('workers', 'core.seed_runs', 'INSERT') AS workers_seed_insert
      `) as Array<Record<string, boolean>>;

      expect(privileges).toMatchObject({
        app_core: true,
        app_pii: false,
        api_pii: false,
        app_tags_select: true,
        app_tags_insert: false,
        app_migrations_select: true,
        api_events_insert: true,
        workers_events_update: true,
        workers_seed_insert: true,
      });

      await sql.close();
    });
  });

  test("seeds are reproducible and run once", async () => {
    const module: SeedModule = {
      name: "test-values",
      async run({ sql, rng }) {
        await sql`CREATE TABLE IF NOT EXISTS core.seed_values (value int NOT NULL)`;

        for (let index = 0; index < 5; index += 1) {
          await sql`INSERT INTO core.seed_values (value) VALUES (${Math.floor(rng() * 1_000_000)})`;
        }
      },
    };

    await withDatabase(async (firstUrl) => {
      await withDatabase(async (secondUrl) => {
        await runMigrations({ databaseUrl: firstUrl });
        await runMigrations({ databaseUrl: secondUrl });

        const firstSql = new SQL(firstUrl);
        const secondSql = new SQL(secondUrl);
        const registry = new SeedRegistry([module]);

        const firstResult = await runSeeds({ sql: firstSql, registry, seed: 42 });
        const secondResult = await runSeeds({ sql: secondSql, registry, seed: 42 });

        expect(firstResult).toEqual({ ran: true, modules: ["test-values"] });
        expect(secondResult).toEqual({ ran: true, modules: ["test-values"] });

        const firstValues = (await firstSql`
          SELECT value FROM core.seed_values ORDER BY value
        `) as Array<{ value: number }>;
        const secondValues = (await secondSql`
          SELECT value FROM core.seed_values ORDER BY value
        `) as Array<{ value: number }>;

        expect(firstValues).toEqual(secondValues);

        const rerun = await runSeeds({ sql: firstSql, registry, seed: 42 });
        expect(rerun).toEqual({ ran: false, modules: [] });

        const [{ count }] = (await firstSql`
          SELECT count(*)::int AS count FROM core.seed_values
        `) as Array<{ count: number }>;
        expect(count).toBe(5);

        await firstSql.close();
        await secondSql.close();
      });
    });
  });

  test("the base seed writes the board settings row once", async () => {
    await withDatabase(async (databaseUrl) => {
      await runMigrations({ databaseUrl });
      const sql = new SQL(databaseUrl);
      const registry = new SeedRegistry([baseSeedModule]);

      expect(await runSeeds({ sql, registry })).toEqual({ ran: true, modules: ["base"] });
      expect(await runSeeds({ sql, registry })).toEqual({ ran: false, modules: [] });

      const settings = (await sql`
        SELECT id, board_name FROM core.board_settings
      `) as Array<{ id: number; board_name: string }>;
      expect(settings).toEqual([{ id: 1, board_name: "Bulletin" }]);

      const runs = (await sql`
        SELECT name, seed, size FROM core.seed_runs
      `) as Array<{ name: string; seed: number | string; size: string }>;
      expect(runs).toHaveLength(1);
      expect(runs[0]?.name).toBe("base");
      expect(Number(runs[0]?.seed)).toBe(42);
      expect(runs[0]?.size).toBe("default");

      await sql.close();
    });
  });

  test("events roll back with their transaction and carry IDs only", async () => {
    await withDatabase(async (databaseUrl) => {
      await runMigrations({ databaseUrl });
      const sql = new SQL(databaseUrl);

      await expect(
        sql.begin(async (tx) => {
          await emit(tx, postCreated());
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      expect(
        (await sql`SELECT count(*)::int AS count FROM core.events`) as Array<{ count: number }>,
      ).toEqual([{ count: 0 }]);

      await sql.begin(async (tx) => {
        await emit(tx, postCreated());
      });

      const rows = (await sql`
        SELECT type, aggregate_type, aggregate_id, aggregate_version, payload_ids, published_at
        FROM core.events
      `) as Array<{
        type: string;
        aggregate_type: string;
        aggregate_id: bigint | string;
        aggregate_version: bigint | string;
        payload_ids: unknown;
        published_at: Date | null;
      }>;

      expect(rows).toHaveLength(1);
      const payloadIds =
        typeof rows[0]?.payload_ids === "string"
          ? (JSON.parse(rows[0].payload_ids) as Record<string, string>)
          : (rows[0]?.payload_ids ?? {});

      expect(rows[0]).toMatchObject({
        type: "post.created",
        aggregate_type: "post",
        aggregate_id: "10",
        aggregate_version: "1",
        published_at: null,
      });
      expect(payloadIds).toEqual({
        postId: "100",
        topicId: "20",
        forumId: "3",
        authorId: "7",
      });
      expect(Object.keys(payloadIds)).not.toContain("text");

      expect(isStaleEvent({ aggregateVersion: 5n }, 6n)).toBe(true);
      expect(isStaleEvent({ aggregateVersion: 6n }, 5n)).toBe(false);

      await sql.close();
    });
  });

  test("relay isolates subscribers and survives a crash between steps", async () => {
    await withDatabase(async (databaseUrl) => {
      await runMigrations({ databaseUrl });
      const sql = new SQL(databaseUrl);
      const queue = new RecordingQueue();
      const relay = createRelay({ sql, subscribers, queue });

      await sql.begin(async (tx) => {
        await emit(tx, postCreated());
      });

      queue.failFor.add("webhook");
      const first = await relay.runOnce();
      expect(first).toEqual({ claimed: 1, published: 0, failed: 1 });
      expect(queue.jobs.map((job) => job.payload.subscriber)).toEqual(["core"]);

      const [{ delivered }] = (await sql`
        SELECT count(*)::int AS delivered FROM core.event_deliveries
      `) as Array<{ delivered: number }>;
      expect(delivered).toBe(2);

      queue.failFor.clear();
      const second = await relay.runOnce();
      expect(second).toEqual({ claimed: 1, published: 1, failed: 0 });
      expect(queue.jobs.map((job) => job.payload.subscriber).sort()).toEqual(["core", "webhook"]);

      const cursors = (await sql`
        SELECT subscriber, last_event_id FROM core.job_cursors ORDER BY subscriber
      `) as Array<{ subscriber: string; last_event_id: bigint | string }>;
      expect(cursors.map((cursor) => cursor.subscriber)).toEqual(["core", "webhook"]);

      const [{ published }] = (await sql`
        SELECT count(*)::int AS published FROM core.events WHERE published_at IS NOT NULL
      `) as Array<{ published: number }>;
      expect(published).toBe(1);

      // Crash after enqueue but before the published marker: the singleton key prevents a
      // duplicate job on the retry.
      await sql.begin(async (tx) => {
        await emit(tx, postCreated(2n));
      });
      queue.failAfterRecord = true;
      await relay.runOnce();
      queue.failAfterRecord = false;
      await relay.runOnce();

      expect(
        queue.jobs
          .filter((job) => job.payload.eventId === "2")
          .map((job) => job.payload.subscriber)
          .sort(),
      ).toEqual(["core", "core", "webhook", "webhook"]);

      const [{ eventTwoPublished }] = (await sql`
        SELECT count(*)::int AS "eventTwoPublished"
        FROM core.events
        WHERE aggregate_version = 2 AND published_at IS NOT NULL
      `) as Array<{ eventTwoPublished: number }>;
      expect(eventTwoPublished).toBe(1);

      await sql.close();
    });
  });

  test("durable subscriber progress survives a completed pg-boss job", async () => {
    await withDatabase(async (databaseUrl) => {
      await runMigrations({ databaseUrl });
      const sql = new SQL(databaseUrl);
      const bossUrl = new URL(databaseUrl);
      bossUrl.username = "workers";
      bossUrl.password = "";

      const boss = await createPgBossQueue({
        connectionString: bossUrl.toString(),
        schema: "pgboss",
        supervise: false,
        schedule: false,
      });

      let failWebhook = true;
      const queue: JobQueue = {
        async send(name, payload, sendOptions) {
          if (failWebhook && payload.subscriber === "webhook") {
            throw new Error("webhook queue unavailable");
          }

          await boss.queue.send(name, payload, sendOptions);
        },
      };
      const relay = createRelay({ sql, subscribers, queue });

      try {
        await sql.begin(async (tx) => {
          await emit(tx, postCreated());
        });

        expect(await relay.runOnce()).toEqual({ claimed: 1, published: 0, failed: 1 });

        // Simulate the successful core job completing and disappearing before the retry.
        await boss.boss.deleteQueuedJobs("domain-events");
        failWebhook = false;
        expect(await relay.runOnce()).toEqual({ claimed: 1, published: 1, failed: 0 });

        const counts = (await sql`
          SELECT data->>'subscriber' AS subscriber, count(*)::int AS count
          FROM pgboss.job
          WHERE name = 'domain-events'
          GROUP BY 1
          ORDER BY 1
        `) as Array<{ subscriber: string; count: number }>;

        expect(counts).toEqual([{ subscriber: "webhook", count: 1 }]);
      } finally {
        await boss.stop();
        await sql.close();
      }
    });
  });

  test("event worker retries a failing subscriber with backoff while another succeeds", async () => {
    await withDatabase(async (databaseUrl) => {
      await runMigrations({ databaseUrl });
      const sql = new SQL(databaseUrl);
      const bossUrl = new URL(databaseUrl);
      bossUrl.username = "workers";
      bossUrl.password = "";

      const boss = await createPgBossQueue({
        connectionString: bossUrl.toString(),
        schema: "pgboss",
        supervise: false,
        schedule: false,
      });

      let coreHandled = 0;
      let webhookAttempts = 0;
      const worker = await createEventWorker({
        boss: boss.boss,
        sql,
        handlers: {
          core: async () => {
            coreHandled += 1;
          },
          webhook: async () => {
            webhookAttempts += 1;
            throw new Error("webhook handler failed");
          },
        },
      });
      const relay = createRelay({ sql, subscribers, queue: boss.queue });

      try {
        await sql.begin(async (tx) => {
          await emit(tx, postCreated());
        });
        expect(await relay.runOnce()).toEqual({ claimed: 1, published: 1, failed: 0 });

        let jobRows: Array<{ subscriber: string; state: string; retry_count: number }> = [];

        for (let attempt = 0; attempt < 200; attempt += 1) {
          jobRows = (await sql`
            SELECT data->>'subscriber' AS subscriber, state, retry_count
            FROM pgboss.job
            WHERE name = 'domain-events'
            ORDER BY subscriber
          `) as typeof jobRows;

          if (
            coreHandled === 1 &&
            webhookAttempts >= 1 &&
            jobRows.some((row) => row.subscriber === "webhook" && row.state === "retry")
          ) {
            break;
          }

          await Bun.sleep(50);
        }

        expect(coreHandled).toBe(1);
        expect(webhookAttempts).toBeGreaterThanOrEqual(1);
        expect(jobRows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ subscriber: "core", state: "completed" }),
            expect.objectContaining({ subscriber: "webhook", state: "retry" }),
          ]),
        );

        const queue = await boss.boss.getQueue("domain-events");
        expect(queue).toMatchObject({ retryBackoff: true, retryDelay: 30 });
      } finally {
        await worker.stop();
        await boss.stop();
        await sql.close();
      }
    });
  }, 20_000);

  test("pg-boss installs its own schema and enqueues singleton jobs", async () => {
    await withDatabase(async (databaseUrl) => {
      await runMigrations({ databaseUrl });

      const bossUrl = new URL(databaseUrl);
      bossUrl.username = "workers";
      bossUrl.password = "";

      const boss = await createPgBossQueue({
        connectionString: bossUrl.toString(),
        schema: "pgboss",
        supervise: false,
        schedule: false,
      });

      try {
        await boss.queue.send(
          "domain-events",
          { eventId: "1", subscriber: "test" },
          { singletonKey: "1:test" },
        );
        await boss.queue.send(
          "domain-events",
          { eventId: "1", subscriber: "test" },
          { singletonKey: "1:test" },
        );
      } finally {
        await boss.stop();
      }

      const sql = new SQL(databaseUrl);
      const [{ count }] = (await sql`
        SELECT count(*)::int AS count FROM pgboss.job WHERE name = 'domain-events'
      `) as Array<{ count: number }>;
      expect(count).toBe(1);
      await sql.close();
    });
  });
});
