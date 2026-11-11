import { describe, expect, test } from "bun:test";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

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

/** Bun's SQLQuery is a thenable; asserting rejection on it directly hangs the runner. */
async function expectQueryError(query: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  let message = "";

  try {
    await query;
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toMatch(pattern);
}

integrationDescribe("identity schema", () => {
  test("creates the member, group and session tables with their columns", async () => {
    await withDb("identity_columns", async ({ sql }) => {
      const rows = (await sql`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'core'
          AND table_name IN (
            'groups', 'members', 'member_groups', 'member_name_history',
            'sessions', 'session_grants', 'login_challenges'
          )
      `) as Array<{ table_name: string; column_name: string }>;

      const byTable = new Map<string, string[]>();

      for (const row of rows) {
        byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.column_name]);
      }

      expect(byTable.get("groups")?.sort()).toEqual(
        [
          "created_at",
          "display_order",
          "icon",
          "id",
          "is_system",
          "key",
          "name_colour",
          "title",
        ].sort(),
      );
      expect(byTable.get("members")?.sort()).toEqual(
        [
          "avatar_blocked_until",
          "avatar_hash",
          "avatar_updated_at",
          "board_marked_at",
          "display_name",
          "id",
          "is_service",
          "joined_at",
          "last_active_at",
          "locale",
          "name_skeleton",
          "post_count",
          "previous_visit_at",
          "promotion_version",
          "reputation",
          "state",
        ].sort(),
      );
      expect(byTable.get("member_groups")?.sort()).toEqual(
        ["created_at", "group_id", "is_primary", "member_id"].sort(),
      );
      expect(byTable.get("member_name_history")?.sort()).toEqual(
        ["changed_at", "changed_by", "id", "member_id", "new_name", "old_name", "reason"].sort(),
      );
      expect(byTable.get("sessions")?.sort()).toEqual(
        [
          "id",
          "member_id",
          "kind",
          "token_hash",
          "previous_token_hash",
          "previous_token_expires_at",
          "rotate_pending",
          "created_at",
          "last_seen_at",
          "reauth_at",
          "last_auth_at",
          "reauth_retry_count",
          "revoked_at",
        ].sort(),
      );
      expect(byTable.get("session_grants")?.sort()).toEqual(
        ["expires_at", "granted_at", "kind", "resource_id", "session_id"].sort(),
      );
      expect(byTable.get("login_challenges")?.sort()).toEqual(
        [
          "id",
          "kind",
          "state",
          "nonce",
          "session_id",
          "code_verifier",
          "return_to",
          "max_age",
          "created_at",
          "expires_at",
          "used_at",
        ].sort(),
      );
    });
  }, 20_000);

  test("seeds the built-in groups exactly once", async () => {
    await withDb("identity_groups", async ({ sql }) => {
      const groups = (await sql`
        SELECT key, title, is_system
        FROM core.groups
        ORDER BY key
      `) as Array<{ key: string; title: string; is_system: boolean }>;

      expect(groups).toEqual([
        { key: "administrators", title: "Administrators", is_system: true },
        { key: "banned", title: "Banned", is_system: true },
        { key: "guests", title: "Guests", is_system: true },
        { key: "members", title: "Members", is_system: true },
        { key: "super_moderators", title: "Super Moderators", is_system: true },
      ]);
    });
  }, 20_000);

  test("enforces display-name, skeleton and primary-group uniqueness", async () => {
    await withDb("identity_names", async ({ sql }) => {
      const [{ id: memberId }] = (await sql`
        INSERT INTO core.members (display_name, name_skeleton)
        VALUES ('Alice', 'alice')
        RETURNING id
      `) as Array<{ id: string }>;

      await expectQueryError(
        sql`
          INSERT INTO core.members (display_name, name_skeleton)
          VALUES ('alice', 'alice-two')
        `,
        /duplicate key/i,
      );

      await expectQueryError(
        sql`
          INSERT INTO core.members (display_name, name_skeleton)
          VALUES ('Alicia', 'alice')
        `,
        /duplicate key/i,
      );

      await expectQueryError(
        sql`
          INSERT INTO core.members (display_name) VALUES ('ab')
        `,
        /members_display_name_length_check/,
      );

      const groups = (await sql`
        SELECT key, id FROM core.groups WHERE key IN ('members', 'administrators') ORDER BY key
      `) as Array<{ key: string; id: string }>;
      const membersGroupId = groups.find((group) => group.key === "members")?.id;
      const administratorsId = groups.find((group) => group.key === "administrators")?.id;

      if (membersGroupId === undefined || administratorsId === undefined) {
        throw new Error("built-in groups are missing");
      }

      await sql`
        INSERT INTO core.member_groups (member_id, group_id, is_primary)
        VALUES (${memberId}, ${membersGroupId}, true)
      `;

      await expectQueryError(
        sql`
          INSERT INTO core.member_groups (member_id, group_id, is_primary)
          VALUES (${memberId}, ${administratorsId}, true)
        `,
        /duplicate key/i,
      );

      await sql`DELETE FROM core.members WHERE id = ${memberId}`;

      const remaining = (await sql`
        SELECT count(*)::int AS count
        FROM core.member_groups
        WHERE member_id = ${memberId}
      `) as Array<{ count: number }>;
      expect(remaining[0]?.count).toBe(0);
    });
  }, 20_000);

  test("keeps session token hashes unique and rotation fields consistent", async () => {
    await withDb("identity_sessions", async ({ sql }) => {
      const [{ id: memberId }] = (await sql`
        INSERT INTO core.members (display_name) VALUES ('Session Owner') RETURNING id
      `) as Array<{ id: string }>;

      const [session] = (await sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (${memberId}, 'user', sha256(convert_to('token-a', 'UTF8')), now() + interval '24 hours')
        RETURNING id, rotate_pending, last_auth_at, revoked_at
      `) as Array<{
        id: string;
        rotate_pending: boolean;
        last_auth_at: Date | null;
        revoked_at: Date | null;
      }>;

      expect(session?.rotate_pending).toBe(false);
      expect(session?.last_auth_at).not.toBeNull();
      expect(session?.revoked_at).toBeNull();

      await expectQueryError(
        sql`
          INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
          VALUES (
            ${memberId}, 'user', sha256(convert_to('token-a', 'UTF8')),
            now() + interval '24 hours'
          )
        `,
        /duplicate key/i,
      );

      await expectQueryError(
        sql`
          UPDATE core.sessions
          SET previous_token_hash = sha256(convert_to('old', 'UTF8'))
          WHERE id = ${session?.id ?? ""}
        `,
        /sessions_previous_token_check/,
      );

      const [challenge] = (await sql`
        INSERT INTO core.login_challenges (kind, state, nonce)
        VALUES ('user', 'state-one', 'nonce-one')
        RETURNING
          used_at,
          expires_at > created_at + interval '9 minutes' AS roughly_ten_minutes,
          expires_at < created_at + interval '11 minutes' AS bounded
      `) as Array<{ used_at: Date | null; roughly_ten_minutes: boolean; bounded: boolean }>;

      expect(challenge?.used_at).toBeNull();
      expect(challenge?.roughly_ten_minutes).toBe(true);
      expect(challenge?.bounded).toBe(true);

      await expectQueryError(
        sql`
          INSERT INTO core.login_challenges (kind, state, nonce)
          VALUES ('user', 'state-one', 'nonce-two')
        `,
        /duplicate key/i,
      );

      await sql`
        INSERT INTO core.session_grants (session_id, kind, resource_id)
        VALUES (${session?.id ?? ""}, 'forum_password', 3)
      `;

      await sql`DELETE FROM core.sessions WHERE id = ${session?.id ?? ""}`;

      const grants = (await sql`
        SELECT count(*)::int AS count FROM core.session_grants
      `) as Array<{ count: number }>;
      expect(grants[0]?.count).toBe(0);
    });
  }, 20_000);

  test("records name changes and clears the string-override author on erasure", async () => {
    await withDb("identity_history", async ({ sql }) => {
      const [{ id: memberId }] = (await sql`
        INSERT INTO core.members (display_name) VALUES ('Old Name') RETURNING id
      `) as Array<{ id: string }>;

      const [history] = (await sql`
        INSERT INTO core.member_name_history (member_id, old_name, new_name)
        VALUES (${memberId}, 'Old Name', 'New Name')
        RETURNING old_name, new_name
      `) as Array<{ old_name: string; new_name: string }>;

      expect(history).toEqual({ old_name: "Old Name", new_name: "New Name" });

      await sql`
        INSERT INTO core.string_overrides (locale, key, value, updated_by)
        VALUES ('en', 'test.key', 'value', ${memberId})
      `;

      await sql`DELETE FROM core.members WHERE id = ${memberId}`;

      const overrides = (await sql`
        SELECT updated_by FROM core.string_overrides WHERE key = 'test.key'
      `) as Array<{ updated_by: string | null }>;

      expect(overrides).toEqual([{ updated_by: null }]);
    });
  }, 20_000);

  test("grants the read and write roles without over-sharing", async () => {
    await withDb("identity_grants", async ({ sql }) => {
      const [privileges] = (await sql`
        SELECT
          has_table_privilege('user_app', 'core.members', 'SELECT') AS app_members_read,
          has_table_privilege('user_app', 'core.members', 'INSERT') AS app_members_write,
          has_table_privilege('user_app', 'core.sessions', 'SELECT') AS app_sessions_read,
          has_table_privilege('user_api', 'core.sessions', 'INSERT') AS api_sessions_write,
          has_table_privilege('user_api', 'core.login_challenges', 'INSERT') AS api_challenges_write,
          has_table_privilege('staff_api', 'core.member_groups', 'UPDATE') AS staff_groups_write,
          has_table_privilege('workers', 'core.members', 'UPDATE') AS workers_members_update
      `) as Array<Record<string, boolean>>;

      expect(privileges).toMatchObject({
        app_members_read: true,
        app_members_write: false,
        app_sessions_read: true,
        api_sessions_write: true,
        api_challenges_write: true,
        staff_groups_write: true,
        workers_members_update: true,
      });
    });
  });
});
