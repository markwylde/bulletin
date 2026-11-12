import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { hashToken } from "@bulletin/domain/auth";
import {
  activeMemberBan,
  banIp,
  banMember,
  isIpBanned,
  listIpBans,
  restoreExpiredMemberBans,
  unbanMember,
} from "@bulletin/domain/bans";
import { can, loadForumTree } from "@bulletin/domain/permissions";
import {
  openIpAccess,
  readLoginIps,
  readMembersByIp,
  readPostIp,
  recordPostIp,
} from "@bulletin/domain/pii";
import { saveMemberProfile } from "@bulletin/domain/profiles";
import { startTopic } from "@bulletin/domain/topics";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "bans_ips" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
      ]),
    });
    await run(database);
  });
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

function expectOk<T>(
  outcome:
    | { readonly ok: true; readonly result: T }
    | { readonly ok: false; readonly code: string },
): T {
  if (!outcome.ok) {
    throw new Error(`Expected success, received ${outcome.code}`);
  }

  return outcome.result;
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

async function staffToken(
  database: TestDatabase,
  actorId: string,
  authAgeMinutes = 0,
): Promise<string> {
  const token = `staff-${crypto.randomUUID()}`;
  await database.sql`
    INSERT INTO core.sessions (
      member_id, kind, token_hash, reauth_at, last_seen_at, last_auth_at
    )
    VALUES (
      ${actorId}, 'staff', ${hashToken(token)},
      now() + interval '1 hour', now(), now() - make_interval(mins => ${authAgeMinutes})
    )
  `;

  return token;
}

integrationDescribe("member bans", () => {
  test("moves a member to Banned, blocks capabilities, and restores timed bans", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      const before = (await database.sql`
        SELECT group_id::text AS group_id, is_primary FROM core.member_groups
        WHERE member_id = ${member} ORDER BY group_id
      `) as Array<{ group_id: string; is_primary: boolean }>;

      const banned = expectOk(
        await banMember(database.sql, {
          actorId: admin,
          memberId: member,
          reason: "Repeated abuse",
          days: 7,
        }),
      );
      expect(banned.id).not.toBe("");
      expect((await activeMemberBan(database.sql, member))?.reason).toBe("Repeated abuse");

      const groups = (await database.sql`
        SELECT g.key FROM core.member_groups mg JOIN core.groups g ON g.id = mg.group_id
        WHERE mg.member_id = ${member}
      `) as Array<{ key: string }>;
      expect(groups).toEqual([{ key: "banned" }]);
      expect(await can(database.sql, member, "post")).toBe(false);
      expect(await can(database.sql, member, "react")).toBe(false);
      expect(await can(database.sql, member, "send_pm")).toBe(false);
      expect(
        await saveMemberProfile(database.sql, {
          memberId: member,
          aboutMd: "A banned member should not change this.",
          hideOnline: false,
          hideFromMemberList: false,
          values: {},
          fields: [],
        }),
      ).toEqual({ ok: false, code: "banned" });

      expect(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Banned member topic",
          bodyMd: "Should not post.",
        }),
      ).toEqual({ ok: false, code: "posting_suspended" });

      // A timed ban's expiry restores every previous group.
      await database.sql`
        UPDATE core.member_bans SET expires_at = now() - interval '1 minute'
        WHERE member_id = ${member}
      `;
      expect(await restoreExpiredMemberBans(database.sql)).toBe(1);
      const restored = (await database.sql`
        SELECT group_id::text AS group_id, is_primary FROM core.member_groups
        WHERE member_id = ${member} ORDER BY group_id
      `) as Array<{ group_id: string; is_primary: boolean }>;
      expect(restored).toEqual(before);
      expect(await activeMemberBan(database.sql, member)).toBeNull();
    });
  }, 60_000);

  test("unbans manually and denies a member without members.ban", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      expectOk(
        await banMember(database.sql, {
          actorId: admin,
          memberId: member,
          reason: "Temporary",
        }),
      );
      expect(await unbanMember(database.sql, { actorId: member, memberId: member })).toEqual({
        ok: false,
        code: "forbidden",
      });
      expectOk(await unbanMember(database.sql, { actorId: admin, memberId: member }));
      expect(await activeMemberBan(database.sql, member)).toBeNull();
    });
  }, 60_000);
});

integrationDescribe("IP bans and audited lookups", () => {
  test("blocks a CIDR, respects expiry and records the ban", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      expectOk(
        await banIp(database.sql, {
          actorId: admin,
          cidr: "203.0.113.0/24",
          reason: "Abuse network",
          days: 30,
        }),
      );
      expect(await isIpBanned(database.sql, "203.0.113.77")).toBe(true);
      expect(await isIpBanned(database.sql, "203.0.114.77")).toBe(false);
      const member = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      expect(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Blocked IP post",
          bodyMd: "Should not post.",
          ip: "203.0.113.77",
        }),
      ).toEqual({ ok: false, code: "forbidden" });
      expect((await listIpBans(database.sql))[0]?.cidr).toBe("203.0.113.0/24");

      await database.sql`
        UPDATE core.ip_bans SET expires_at = now() - interval '1 minute'
        WHERE cidr = '203.0.113.0/24'::inet
      `;
      expect(await isIpBanned(database.sql, "203.0.113.77")).toBe(false);
      expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Unblocked IP post",
          bodyMd: "Now it can post.",
          ip: "203.0.113.77",
        }),
      );

      expect(
        await banIp(database.sql, {
          actorId: await memberId(database, "member-1"),
          cidr: "198.51.100.0/24",
          reason: "Denied",
        }),
      ).toEqual({ ok: false, code: "invalid_request" });
    });
  }, 60_000);

  test("audits a post IP read before returning it and expires old data", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "IP lookup target",
          bodyMd: "A post with an IP.",
        }),
      );
      await withRole(database, "user_api", async (sql) => {
        await recordPostIp(sql, topic.postId, "203.0.113.77");
      });

      const token = await staffToken(database, admin);
      const grant = await openIpAccess(database.sql, {
        sessionToken: token,
        purpose: "post_ip",
        resourceType: "post",
        resourceId: topic.postId,
      });
      expect(grant).toBeString();

      // The audit row is committed before the read call returns any data.
      const [audit] = (await database.sql`
        SELECT purpose, resource_id::text AS resource_id FROM pii.access_log
        ORDER BY id DESC LIMIT 1
      `) as Array<{ purpose: string; resource_id: string }>;
      expect(audit).toEqual({ purpose: "post_ip", resource_id: topic.postId });

      expect(await readPostIp(database.sql, grant ?? "")).toEqual({
        ip: "203.0.113.77",
        expired: false,
      });
      expect(await readPostIp(database.sql, grant ?? "")).toBeNull();

      await database.sql`
        UPDATE core.posts SET created_at = now() - interval '120 days' WHERE id = ${topic.postId}
      `;
      const expiredGrant = await openIpAccess(database.sql, {
        sessionToken: token,
        purpose: "post_ip",
        resourceType: "post",
        resourceId: topic.postId,
      });
      expect(await readPostIp(database.sql, expiredGrant ?? "")).toEqual({
        ip: null,
        expired: true,
      });
    });
  }, 60_000);

  test("denies step-up, missing power and role-level access", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const forumMod = await memberId(database, "forum-mod");
      const forum = await forumId(database, "off-topic");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "IP denial target",
          bodyMd: "A post.",
        }),
      );
      await withRole(database, "user_api", async (sql) => {
        await recordPostIp(sql, topic.postId, "203.0.113.88");
      });

      const stale = await staffToken(database, admin, 30);
      expect(
        await openIpAccess(database.sql, {
          sessionToken: stale,
          purpose: "post_ip",
          resourceType: "post",
          resourceId: topic.postId,
        }),
      ).toBeNull();

      const fresh = await staffToken(database, forumMod);
      expect(
        await openIpAccess(database.sql, {
          sessionToken: fresh,
          purpose: "post_ip",
          resourceType: "post",
          resourceId: topic.postId,
        }),
      ).toBeNull();

      const grants = (await database.sql`
        SELECT r,
          has_function_privilege(r, 'pii.read_post_ip(bigint)', 'EXECUTE') AS post_allowed,
          has_function_privilege(r, 'pii.record_post_ip(bigint, inet)', 'EXECUTE') AS record_allowed,
          has_table_privilege(r, 'pii.post_ips', 'SELECT') AS table_allowed
        FROM unnest(ARRAY['staff_api', 'user_api', 'user_app', 'workers']) AS r
        ORDER BY r
      `) as Array<{
        r: string;
        post_allowed: boolean;
        record_allowed: boolean;
        table_allowed: boolean;
      }>;
      expect(grants).toEqual([
        { r: "staff_api", post_allowed: true, record_allowed: false, table_allowed: false },
        { r: "user_api", post_allowed: false, record_allowed: true, table_allowed: false },
        { r: "user_app", post_allowed: false, record_allowed: false, table_allowed: false },
        { r: "workers", post_allowed: false, record_allowed: false, table_allowed: false },
      ]);
    });
  }, 60_000);

  test("scopes reverse lookups to view-IP forums and audits them separately", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const forumMod = await memberId(database, "forum-mod");
      const staff = await staffToken(database, forumMod);
      const loaded = await loadForumTree(database.sql);
      const forums = (await database.sql`
        SELECT id::text AS id FROM core.forums WHERE type = 'forum' ORDER BY id
      `) as Array<{ id: string }>;
      const scoped = [];

      for (const forum of forums) {
        if (
          (await can(database.sql, forumMod, "view_ips", {
            forumId: forum.id,
            tree: loaded,
          })) &&
          (await can(database.sql, member, "start", { forumId: forum.id, tree: loaded }))
        ) {
          scoped.push(forum.id);
        }
      }

      const inScope = scoped[0];
      const outOfScope = (
        await Promise.all(
          forums.map(async (forum) => ({
            id: forum.id,
            allowed: await can(database.sql, member, "start", { forumId: forum.id, tree: loaded }),
          })),
        )
      ).find((forum) => forum.allowed && !scoped.includes(forum.id));

      if (inScope === undefined || outOfScope === undefined) {
        throw new Error("Missing scoped/unscoped forums");
      }

      const source = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: inScope,
          title: "Scoped IP source",
          bodyMd: "In scope.",
        }),
      );
      const other = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: outOfScope.id,
          title: "Out of scope source",
          bodyMd: "Out of scope.",
        }),
      );
      await withRole(database, "user_api", async (sql) => {
        await recordPostIp(sql, source.postId, "203.0.113.99");
        await recordPostIp(sql, other.postId, "203.0.113.99");
      });

      const grant = await openIpAccess(database.sql, {
        sessionToken: staff,
        purpose: "reverse_ip",
        resourceType: "post",
        resourceId: source.postId,
      });
      const members = await readMembersByIp(database.sql, grant ?? "");
      expect(members.map((row) => row.forumId)).toEqual([inScope]);
      const [audit] = (await database.sql`
        SELECT purpose FROM pii.access_log ORDER BY id DESC LIMIT 1
      `) as Array<{ purpose: string }>;
      expect(audit?.purpose).toBe("reverse_ip");

      expect(
        await openIpAccess(database.sql, {
          sessionToken: staff,
          purpose: "login_ips",
          resourceType: "member",
          resourceId: member,
        }),
      ).toBeNull();

      const token = await staffToken(database, admin);
      const loginGrant = await openIpAccess(database.sql, {
        sessionToken: token,
        purpose: "login_ips",
        resourceType: "member",
        resourceId: member,
      });
      await withRole(database, "user_api", async (sql) => {
        await sql`SELECT pii.record_login_ip(${member}, '198.51.100.10'::inet)`;
      });
      expect((await readLoginIps(database.sql, loginGrant ?? ""))[0]?.ip).toBe("198.51.100.10");
      const [loginAudit] = (await database.sql`
        SELECT purpose, resource_id::text AS resource_id FROM pii.access_log
        ORDER BY id DESC LIMIT 1
      `) as Array<{ purpose: string; resource_id: string }>;
      expect(loginAudit).toEqual({ purpose: "login_ips", resource_id: member });
    });
  }, 90_000);
});
