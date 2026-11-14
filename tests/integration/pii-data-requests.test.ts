import { describe, expect, test } from "bun:test";
import { displayNameSkeleton } from "@bulletin/domain/member";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";

/**
 * Data-subject requests and the audited PII log (ADR 0012; privacy-gdpr task 1.3). Every
 * function derives the actor from a session token and checks the ACP permission in SQL.
 */

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

function roleUrl(database: TestDatabase, role: string): string {
  const url = new URL(database.url);
  url.username = role;
  url.password = "";
  return url.toString();
}

async function withRole(
  database: TestDatabase,
  role: string,
  run: (sql: SQL) => Promise<void>,
): Promise<void> {
  const sql = new SQL(roleUrl(database, role));

  try {
    await run(sql);
  } finally {
    await sql.close();
  }
}

async function createMember(
  database: TestDatabase,
  name: string,
  groups: readonly string[] = ["members"],
): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES (${name}, ${displayNameSkeleton(name)})
    RETURNING id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error(`Could not create ${name}`);
  }

  const rows = (await database.sql`
    SELECT key, id FROM core.groups WHERE key = ANY (${`{${groups.join(",")}}`}::text[])
  `) as Array<{ key: string; id: string }>;
  const byKey = new Map(rows.map((row) => [row.key, row.id]));

  for (const [index, key] of groups.entries()) {
    const groupId = byKey.get(key);

    if (groupId === undefined) {
      throw new Error(`Missing group ${key}`);
    }

    await database.sql`
      INSERT INTO core.member_groups (member_id, group_id, is_primary)
      VALUES (${member.id}, ${groupId}, ${index === 0})
    `;
  }

  return member.id;
}

async function createSession(
  database: TestDatabase,
  memberId: string,
  kind: "user" | "staff",
  token: string,
): Promise<void> {
  await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
    VALUES (
      ${memberId}, ${kind}, sha256(convert_to(${token}, 'UTF8')), now() + interval '24 hours'
    )
  `;
}

async function createRequest(
  database: TestDatabase,
  token: string,
  kind: "export" | "erasure",
): Promise<string> {
  let requestId = "";

  await withRole(database, "user_api", async (sql) => {
    const [row] = (await sql`
      SELECT pii.create_data_request(${token}, ${kind}) AS id
    `) as Array<{ id: string | null }>;
    requestId = row?.id ?? "";
  });

  if (requestId === "") {
    throw new Error("create_data_request returned no id");
  }

  return requestId;
}

async function listRequests(
  database: TestDatabase,
  token: string,
  filters: Record<string, unknown> = {},
): Promise<Array<Record<string, unknown>>> {
  let rows: Array<Record<string, unknown>> = [];

  await withRole(database, "staff_api", async (sql) => {
    rows = (await sql`
      SELECT id::text AS id, member_id::text AS member_id, kind, status, reason,
        decision_reason, created_at, updated_at, due_at, completed_at
      FROM pii.list_data_requests(${token}, ${filters}::jsonb)
    `) as Array<Record<string, unknown>>;
  });

  return rows;
}

async function updateRequest(
  database: TestDatabase,
  token: string,
  requestId: string,
  action: string,
  reason: string | null,
): Promise<void> {
  await withRole(database, "staff_api", async (sql) => {
    await sql`
      SELECT pii.update_data_request(${token}, ${requestId}, ${action}, ${reason})
    `;
  });
}

async function requestRow(
  database: TestDatabase,
  requestId: string,
): Promise<{
  status: string;
  reason: string | null;
  decision_reason: string | null;
  decided_by: string | null;
  completed_at: Date | null;
}> {
  const [row] = (await database.sql`
    SELECT status, reason, decision_reason, decided_by::text AS decided_by, completed_at
    FROM pii.data_requests WHERE id = ${requestId}
  `) as Array<{
    status: string;
    reason: string | null;
    decision_reason: string | null;
    decided_by: string | null;
    completed_at: Date | null;
  }>;

  if (row === undefined) {
    throw new Error("request disappeared");
  }

  return row;
}

async function auditPurposes(database: TestDatabase): Promise<string[]> {
  const rows = (await database.sql`
    SELECT purpose FROM pii.access_log ORDER BY id
  `) as Array<{ purpose: string }>;
  return rows.map((row) => row.purpose);
}

async function expectQueryError(query: PromiseLike<unknown>): Promise<void> {
  let message = "";

  try {
    await query;
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toMatch(/permission denied/i);
}

integrationDescribe("data subject requests", () => {
  test("members open one request per kind from their own session", async () => {
    await withDb("data_request_create", async (database) => {
      const alice = await createMember(database, "Request Alice");
      const bob = await createMember(database, "Request Bob");
      await createSession(database, alice, "user", "alice-requests");
      await createSession(database, bob, "user", "bob-requests");

      const first = await createRequest(database, "alice-requests", "export");
      const repeated = await createRequest(database, "alice-requests", "export");
      const erasure = await createRequest(database, "alice-requests", "erasure");
      const bobRequest = await createRequest(database, "bob-requests", "export");

      expect(repeated).toBe(first);
      expect(new Set([first, erasure, bobRequest]).size).toBe(3);

      const requests = (await database.sql`
        SELECT id::text AS id, member_id::text AS member_id, kind, status, due_at,
          due_at - created_at AS window
        FROM pii.data_requests
        ORDER BY id
      `) as Array<{
        id: string;
        member_id: string;
        kind: string;
        status: string;
        due_at: Date;
        window: string;
      }>;

      expect(requests.map((row) => row.member_id)).toEqual([alice, alice, bob]);
      expect(requests.map((row) => row.kind)).toEqual(["export", "erasure", "export"]);
      expect(requests.map((row) => row.status)).toEqual(["pending", "pending", "pending"]);

      for (const request of requests) {
        expect(request.due_at.getTime()).toBeGreaterThan(Date.now());
        // Postgres prints an interval of exactly 30 days.
        expect(request.window).toContain("30 days");
      }

      await withRole(database, "user_api", async (sql) => {
        const [invalid] = (await sql`
          SELECT pii.create_data_request('alice-requests', 'delete-everything') AS id,
            pii.create_data_request('not-a-session', 'export') AS denied
        `) as Array<{ id: string | null; denied: string | null }>;
        expect(invalid).toEqual({ id: null, denied: null });
      });

      await database.sql`UPDATE core.members SET state = 'erasing' WHERE id = ${alice}`;
      await withRole(database, "user_api", async (sql) => {
        const [blocked] = (await sql`
          SELECT pii.create_data_request('alice-requests', 'export') AS id
        `) as Array<{ id: string | null }>;
        expect(blocked?.id).toBeNull();
      });

      expect(
        (await auditPurposes(database)).filter((purpose) => purpose === "own_data"),
      ).toHaveLength(4);

      await withRole(database, "staff_api", async (sql) => {
        await expectQueryError(sql`SELECT pii.create_data_request('alice-requests', 'export')`);
      });
    });
  }, 30_000);

  test("the staff queue needs privacy.requests and filters by kind, member and overdue", async () => {
    await withDb("data_request_list", async (database) => {
      const alice = await createMember(database, "Queue Alice");
      const bob = await createMember(database, "Queue Bob");
      await createSession(database, alice, "user", "queue-alice");
      await createSession(database, bob, "user", "queue-bob");

      const exportRequest = await createRequest(database, "queue-alice", "export");
      const erasureRequest = await createRequest(database, "queue-bob", "erasure");

      const admin = await createMember(database, "Queue Admin", ["administrators"]);
      const clerk = await createMember(database, "Queue Clerk", ["members"]);
      await createSession(database, admin, "staff", "queue-admin");
      await createSession(database, clerk, "staff", "queue-clerk");

      const all = await listRequests(database, "queue-admin");
      expect(all.map((row) => row.id).sort()).toEqual([exportRequest, erasureRequest].sort());

      const exports = await listRequests(database, "queue-admin", { kind: "export" });
      expect(exports).toEqual([
        expect.objectContaining({ id: exportRequest, member_id: alice, status: "pending" }),
      ]);

      const bobs = await listRequests(database, "queue-admin", { member_id: bob });
      expect(bobs.map((row) => row.id)).toEqual([erasureRequest]);

      await database.sql`
        UPDATE pii.data_requests
        SET due_at = now() - interval '1 day'
        WHERE id = ${exportRequest}
      `;
      const overdue = await listRequests(database, "queue-admin", { overdue: true });
      expect(overdue.map((row) => row.id)).toEqual([exportRequest]);

      const fresh = await listRequests(database, "queue-admin", { overdue: false });
      expect(fresh.map((row) => row.id)).toEqual([erasureRequest]);

      expect(await listRequests(database, "queue-clerk")).toEqual([]);

      expect(
        (await auditPurposes(database)).filter((purpose) => purpose === "request_queue"),
      ).toHaveLength(5);

      await withRole(database, "user_api", async (sql) => {
        await expectQueryError(sql`SELECT * FROM pii.list_data_requests('queue-alice')`);
      });
    });
  }, 30_000);

  test("staff process, complete and reject requests with an audited reason", async () => {
    await withDb("data_request_update", async (database) => {
      const alice = await createMember(database, "Decision Alice");
      await createSession(database, alice, "user", "decision-alice");
      const requestId = await createRequest(database, "decision-alice", "erasure");

      const admin = await createMember(database, "Decision Admin", ["administrators"]);
      const clerk = await createMember(database, "Decision Clerk", ["members"]);
      await createSession(database, admin, "staff", "decision-admin");
      await createSession(database, clerk, "staff", "decision-clerk");

      // A clerk without privacy.requests cannot change anything.
      await updateRequest(database, "decision-clerk", requestId, "process", null);
      expect((await requestRow(database, requestId)).status).toBe("pending");

      // A rejection without a reason is a no-op.
      await updateRequest(database, "decision-admin", requestId, "reject", "  ");
      expect((await requestRow(database, requestId)).status).toBe("pending");

      await updateRequest(database, "decision-admin", requestId, "process", "Starting erasure");
      expect(await requestRow(database, requestId)).toMatchObject({
        status: "processing",
        decision_reason: "Starting erasure",
        decided_by: admin,
        completed_at: null,
      });

      // Out-of-order transitions are refused.
      await updateRequest(database, "decision-admin", requestId, "process", null);
      expect((await requestRow(database, requestId)).status).toBe("processing");

      await updateRequest(database, "decision-admin", requestId, "complete", "Erasure done");
      const completed = await requestRow(database, requestId);
      expect(completed.status).toBe("completed");
      expect(completed.decision_reason).toBe("Erasure done");
      expect(completed.decided_by).toBe(admin);
      expect(completed.completed_at).not.toBeNull();

      await updateRequest(database, "decision-admin", requestId, "reject", "Too late");
      expect((await requestRow(database, requestId)).status).toBe("completed");

      const secondMember = await createMember(database, "Decision Second");
      await createSession(database, secondMember, "user", "decision-second");
      const second = await createRequest(database, "decision-second", "erasure");
      expect(second).not.toBe(requestId);
      await updateRequest(database, "decision-admin", second, "reject", "Duplicate request");
      expect(await requestRow(database, second)).toMatchObject({
        status: "rejected",
        decision_reason: "Duplicate request",
      });

      expect(
        (await auditPurposes(database)).filter((purpose) => purpose === "request_update"),
      ).toHaveLength(3);

      await withRole(database, "user_api", async (sql) => {
        await expectQueryError(
          sql`SELECT pii.update_data_request('decision-alice', ${requestId}, 'process', null)`,
        );
      });
      await withRole(database, "workers", async (sql) => {
        await expectQueryError(
          sql`SELECT pii.update_data_request('decision-alice', ${requestId}, 'process', null)`,
        );
      });
    });
  }, 30_000);

  test("workers record retryable steps and every call is audited", async () => {
    await withDb("data_request_steps", async (database) => {
      const alice = await createMember(database, "Step Alice");
      await createSession(database, alice, "user", "step-alice");
      const requestId = await createRequest(database, "step-alice", "erasure");

      await withRole(database, "workers", async (sql) => {
        await sql`SELECT pii.update_request_step(${requestId}, 'plugin_erase', 'running')`;
        await sql`SELECT pii.update_request_step(${requestId}, 'plugin_erase', 'failed')`;
        await sql`SELECT pii.update_request_step(${requestId}, 'plugin_erase', 'running')`;
        await sql`SELECT pii.update_request_step(${requestId}, 'plugin_erase', 'completed')`;
        await sql`SELECT pii.update_request_step(${requestId}, 'posts', 'completed')`;
        await sql`SELECT pii.update_request_step(${requestId}, '  ', 'completed')`;
        await sql`SELECT pii.update_request_step(${requestId}, 'unknown', 'sideways')`;
      });

      const steps = (await database.sql`
        SELECT step, state, error, completed_at
        FROM pii.data_request_steps
        WHERE request_id = ${requestId}
        ORDER BY step
      `) as Array<{
        step: string;
        state: string;
        error: string | null;
        completed_at: Date | null;
      }>;

      expect(steps).toEqual([
        { step: "plugin_erase", state: "completed", error: null, completed_at: expect.any(Date) },
        { step: "posts", state: "completed", error: null, completed_at: expect.any(Date) },
      ]);

      expect(
        (await auditPurposes(database)).filter((purpose) => purpose === "request_step"),
      ).toHaveLength(5);

      for (const role of ["user_api", "staff_api"] as const) {
        await withRole(database, role, async (sql) => {
          await expectQueryError(
            sql`SELECT pii.update_request_step(${requestId}, 'posts', 'completed')`,
          );
        });
      }
    });
  }, 30_000);

  test("the audit viewer needs a committed two-transaction grant and privacy.audit", async () => {
    await withDb("pii_access_log", async (database) => {
      const moderator = await createMember(database, "Audit Moderator", ["administrators"]);
      const admin = await createMember(database, "Audit Admin", ["administrators"]);
      const stranger = await createMember(database, "Audit Stranger", ["members"]);
      await createSession(database, moderator, "staff", "audit-moderator");
      await createSession(database, admin, "staff", "audit-admin");
      await createSession(database, stranger, "staff", "audit-stranger");

      await database.sql`
        INSERT INTO pii.access_log (
          actor_member_id, subject_member_id, purpose, resource_type, resource_id, created_at
        ) VALUES
          (${moderator}, ${moderator}, 'post_ip', 'post', '10', now() - interval '2 days'),
          (${moderator}, ${moderator}, 'post_ip', 'post', '11', now() - interval '1 day'),
          (${moderator}, ${moderator}, 'login_ips', 'member', '12', now()),
          (${admin}, ${moderator}, 'own_data', 'session', '13', now())
      `;

      // A grant raised and redeemed in the same transaction is still in progress.
      const sameTransaction = await database.sql.begin(async (tx) => {
        const [grant] = (await tx`
          SELECT pii.open_access('audit-admin', 'access_log', 'access_log', 0) AS id
        `) as Array<{ id: string | null }>;

        if (grant?.id == null) {
          throw new Error("audit grant was not opened");
        }

        return (await tx`
          SELECT * FROM pii.read_access_log('audit-admin', ${grant.id})
        `) as unknown[];
      });
      expect(sameTransaction).toEqual([]);

      // A staff member without privacy.audit cannot open a grant at all.
      await withRole(database, "staff_api", async (sql) => {
        const [denied] = (await sql`
          SELECT pii.open_access('audit-stranger', 'access_log', 'access_log', 0) AS id
        `) as Array<{ id: string | null }>;
        expect(denied?.id).toBeNull();
      });

      const [grant] = (await database.sql`
        SELECT pii.open_access('audit-admin', 'access_log', 'access_log', 0) AS id
      `) as Array<{ id: string }>;

      if (grant === undefined) {
        throw new Error("audit grant was not opened");
      }

      let rows: Array<Record<string, unknown>> = [];
      await withRole(database, "staff_api", async (sql) => {
        rows = (await sql`
          SELECT id::text AS id, actor_member_id::text AS actor_member_id,
            subject_member_id::text AS subject_member_id, purpose, resource_type, resource_id,
            created_at
          FROM pii.read_access_log(
            'audit-admin',
            ${grant.id},
            ${{ actor_member_id: moderator, purpose: "post_ip" }}::jsonb
          )
        `) as Array<Record<string, unknown>>;
      });

      expect(rows.map((row) => row.resource_id)).toEqual(["11", "10"]);
      expect(rows.every((row) => row.actor_member_id === moderator)).toBe(true);

      // The same grant cannot be redeemed twice, and another session cannot redeem it.
      await withRole(database, "staff_api", async (sql) => {
        const twice = (await sql`
          SELECT * FROM pii.read_access_log('audit-admin', ${grant.id})
        `) as unknown[];
        expect(twice).toEqual([]);
      });

      const [secondGrant] = (await database.sql`
        SELECT pii.open_access('audit-admin', 'access_log', 'access_log', 0) AS id
      `) as Array<{ id: string }>;

      if (secondGrant === undefined) {
        throw new Error("second audit grant was not opened");
      }

      await withRole(database, "staff_api", async (sql) => {
        const stolen = (await sql`
          SELECT * FROM pii.read_access_log('audit-stranger', ${secondGrant.id})
        `) as unknown[];
        expect(stolen).toEqual([]);
      });

      // Date filtering and the default cap are applied inside SQL.
      const [thirdGrant] = (await database.sql`
        SELECT pii.open_access('audit-admin', 'access_log', 'access_log', 0) AS id
      `) as Array<{ id: string }>;

      if (thirdGrant === undefined) {
        throw new Error("third audit grant was not opened");
      }

      await withRole(database, "staff_api", async (sql) => {
        const recent = (await sql`
          SELECT resource_id FROM pii.read_access_log(
            'audit-admin',
            ${thirdGrant.id},
            ${{ from: new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString(), limit: 1 }}::jsonb
          )
        `) as Array<{ resource_id: string }>;
        expect(recent).toHaveLength(1);
      });

      for (const role of ["user_api", "workers"] as const) {
        await withRole(database, role, async (sql) => {
          await expectQueryError(
            sql`SELECT * FROM pii.read_access_log('audit-admin', ${grant.id})`,
          );
        });
      }
    });
  }, 30_000);
});
