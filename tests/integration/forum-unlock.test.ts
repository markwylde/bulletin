import { describe, expect, test } from "bun:test";
import { displayNameSkeleton } from "@bulletin/domain/member";
import {
  type ForumAction,
  forumActionMask,
  hashForumPassword,
  loadSessionUnlocks,
  UNLOCK_WINDOW_MS,
  unlockForum,
} from "@bulletin/domain/permissions";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { forumUnlockResponse } from "../../apps/user-api/src/forum-unlock.ts";

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

async function createForum(database: TestDatabase, passwordHash: string | null): Promise<string> {
  const [forum] = (await database.sql`
    INSERT INTO core.forums (password_hash)
    VALUES (${passwordHash})
    RETURNING id
  `) as Array<{ id: string }>;

  if (forum === undefined) {
    throw new Error("Could not create forum");
  }

  return forum.id;
}

async function createMember(
  database: TestDatabase,
  name: string,
  groupKey: string,
): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES (${name}, ${displayNameSkeleton(name)})
    RETURNING id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error(`Could not create ${name}`);
  }

  await database.sql`
    INSERT INTO core.member_groups (member_id, group_id, is_primary)
    SELECT ${member.id}, g.id, true
    FROM core.groups g
    WHERE g.key = ${groupKey}
  `;

  return member.id;
}

async function createSession(database: TestDatabase, memberId: string): Promise<string> {
  const [session] = (await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
    VALUES (
      ${memberId}, 'user', sha256(convert_to(${crypto.randomUUID()}, 'UTF8')),
      now() + interval '24 hours'
    )
    RETURNING id
  `) as Array<{ id: string }>;

  if (session === undefined) {
    throw new Error("Could not create session");
  }

  return session.id;
}

async function grantRead(
  database: TestDatabase,
  forumId: string,
  groupKey: string,
  actions: readonly ForumAction[] = ["show", "read"],
): Promise<void> {
  const [mask] = (await database.sql`
    INSERT INTO core.masks (key, title) VALUES ('standard', 'Standard')
    ON CONFLICT (key) DO UPDATE SET title = EXCLUDED.title
    RETURNING id
  `) as Array<{ id: string }>;

  const [group] = (await database.sql`
    SELECT id FROM core.groups WHERE key = ${groupKey}
  `) as Array<{ id: string }>;

  if (mask === undefined || group === undefined) {
    throw new Error("Could not set up the mask");
  }

  await database.sql`
    INSERT INTO core.group_masks (group_id, mask_id) VALUES (${group.id}, ${mask.id})
    ON CONFLICT DO NOTHING
  `;
  await database.sql`
    INSERT INTO core.forum_permissions (forum_id, mask_id, actions, inherits)
    VALUES (${forumId}, ${mask.id}, ${forumActionMask(actions)}, false)
    ON CONFLICT (forum_id, mask_id) DO UPDATE
      SET actions = EXCLUDED.actions, inherits = EXCLUDED.inherits
  `;
}

integrationDescribe("forum password unlocks", () => {
  test("unlocks a readable password forum for the session only", async () => {
    await withDb("unlock_success", async (database) => {
      const forum = await createForum(database, await hashForumPassword("let-me-in"));
      await grantRead(database, forum, "members");
      const member = await createMember(database, "Unlock Member", "members");
      const session = await createSession(database, member);
      const now = new Date("2026-11-10T12:00:00Z");

      expect(
        await unlockForum(database.sql, {
          sessionId: session,
          memberId: member,
          forumId: forum,
          password: "let-me-in",
          now,
        }),
      ).toEqual({ kind: "unlocked" });

      expect([...(await loadSessionUnlocks(database.sql, session))]).toEqual([forum]);

      await database.sql`DELETE FROM core.sessions WHERE id = ${session}`;
      expect([...(await loadSessionUnlocks(database.sql, session))]).toEqual([]);
    });
  }, 30_000);

  test("refuses five wrong passwords and throttles further attempts for ten minutes", async () => {
    await withDb("unlock_throttle", async (database) => {
      const forum = await createForum(database, await hashForumPassword("let-me-in"));
      await grantRead(database, forum, "members");
      const member = await createMember(database, "Throttled Member", "members");
      const session = await createSession(database, member);
      const start = new Date("2026-11-10T12:00:00Z");
      const attemptTimes = [0, 2, 4, 6, 9].map(
        (minutes) => new Date(start.getTime() + minutes * 60_000),
      );

      for (const at of attemptTimes) {
        expect(
          await unlockForum(database.sql, {
            sessionId: session,
            memberId: member,
            forumId: forum,
            password: "wrong",
            now: at,
          }),
        ).toEqual({ kind: "wrong_password" });
      }

      const fifth = attemptTimes[attemptTimes.length - 1] as Date;
      const throttled = await unlockForum(database.sql, {
        sessionId: session,
        memberId: member,
        forumId: forum,
        password: "let-me-in",
        now: fifth,
      });
      expect(throttled.kind).toBe("throttled");

      if (throttled.kind === "throttled") {
        expect(throttled.retryAfterMs).toBeGreaterThan(UNLOCK_WINDOW_MS - 1_000);
        expect(throttled.retryAfterMs).toBeLessThanOrEqual(UNLOCK_WINDOW_MS);
      }

      // One minute after the fifth failure the lockout is still active; the pre-fix
      // oldest-of-five calculation would have unlocked it already.
      const oneMinuteLater = new Date(fifth.getTime() + 60_000);
      expect(
        await unlockForum(database.sql, {
          sessionId: session,
          memberId: member,
          forumId: forum,
          password: "let-me-in",
          now: oneMinuteLater,
        }),
      ).toMatchObject({ kind: "throttled" });

      const later = new Date(fifth.getTime() + UNLOCK_WINDOW_MS + 1);
      expect(
        await unlockForum(database.sql, {
          sessionId: session,
          memberId: member,
          forumId: forum,
          password: "let-me-in",
          now: later,
        }),
      ).toEqual({ kind: "unlocked" });
    });
  }, 30_000);

  test("keeps the counter for a session and forum only", async () => {
    await withDb("unlock_scope", async (database) => {
      const forum = await createForum(database, await hashForumPassword("let-me-in"));
      const otherForum = await createForum(database, await hashForumPassword("other"));
      await grantRead(database, forum, "members");
      await grantRead(database, otherForum, "members");
      const member = await createMember(database, "Scoped Member", "members");
      const session = await createSession(database, member);
      const now = new Date("2026-11-10T12:00:00Z");

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await unlockForum(database.sql, {
          sessionId: session,
          memberId: member,
          forumId: forum,
          password: "wrong",
          now,
        });
      }

      expect(
        await unlockForum(database.sql, {
          sessionId: session,
          memberId: member,
          forumId: otherForum,
          password: "other",
          now,
        }),
      ).toEqual({ kind: "unlocked" });
    });
  }, 30_000);

  test("maps the unlock result to cache-busting HTTP responses", async () => {
    await withDb("unlock_route", async (database) => {
      const forum = await createForum(database, await hashForumPassword("let-me-in"));
      await grantRead(database, forum, "members");
      const member = await createMember(database, "Route Member", "members");
      const session = await createSession(database, member);

      const call = (password: unknown): Promise<Response> =>
        forumUnlockResponse(
          database.sql,
          { id: session, memberId: member },
          forum,
          new Request("http://bulletin.test/api/forums/1/unlock", {
            method: "POST",
            body: JSON.stringify({ password }),
          }),
        );

      const ok = await call("let-me-in");
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toBe("no-store");
      expect(await ok.json()).toEqual({ unlocked: true });

      const wrong = await call("nope");
      expect(wrong.status).toBe(403);
      expect(await wrong.json()).toEqual({ code: "wrong_password" });

      const invalid = await call(null);
      expect(invalid.status).toBe(400);

      const missing = await forumUnlockResponse(
        database.sql,
        { id: session, memberId: member },
        "999999",
        new Request("http://bulletin.test/api/forums/999999/unlock", {
          method: "POST",
          body: JSON.stringify({ password: "let-me-in" }),
        }),
      );
      expect(missing.status).toBe(404);
    });
  }, 30_000);

  test("denies a member without read, a missing forum and a forum without a password", async () => {
    await withDb("unlock_denials", async (database) => {
      const protectedForum = await createForum(database, await hashForumPassword("secret"));
      const openForum = await createForum(database, null);
      const member = await createMember(database, "Denied Member", "members");
      const session = await createSession(database, member);

      expect(
        await unlockForum(database.sql, {
          sessionId: session,
          memberId: member,
          forumId: protectedForum,
          password: "secret",
        }),
      ).toEqual({ kind: "forbidden" });

      await grantRead(database, openForum, "members");

      expect(
        await unlockForum(database.sql, {
          sessionId: session,
          memberId: member,
          forumId: openForum,
          password: "secret",
        }),
      ).toEqual({ kind: "no_password" });

      expect(
        await unlockForum(database.sql, {
          sessionId: session,
          memberId: member,
          forumId: "999999",
          password: "secret",
        }),
      ).toEqual({ kind: "not_found" });
    });
  }, 30_000);
});
