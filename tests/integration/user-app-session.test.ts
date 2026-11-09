import { describe, expect, test } from "bun:test";
import { hashToken } from "@bulletin/domain/auth";
import { withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";
import { readSessionReauthAt } from "../../apps/user-app/src/session.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

function roleUrl(databaseUrl: string, role: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = "";
  return url.toString();
}

integrationDescribe("user-app session read", () => {
  test("reads reauth_at in-process without touching activity", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "user_app_session" }, async ({ sql, url }) => {
      const [member] = (await sql`
        INSERT INTO core.members (display_name, last_active_at, previous_visit_at)
        VALUES ('Read Only', '2020-01-01T00:00:00Z', '2019-01-01T00:00:00Z')
        RETURNING id
      `) as Array<{ id: string }>;

      if (member === undefined) {
        throw new Error("member missing");
      }

      const token = "user-app-session-token";
      await sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (${member.id}, 'user', ${hashToken(token)}, now() + interval '24 hours')
      `;

      const appSql = new SQL(roleUrl(url, "user_app"));

      try {
        const reauthAt = await readSessionReauthAt(appSql, `bl_session=${token}`, "test");
        expect(reauthAt).not.toBeNull();

        const [after] = (await sql`
          SELECT last_active_at, previous_visit_at FROM core.members WHERE id = ${member.id}
        `) as Array<{ last_active_at: Date; previous_visit_at: Date }>;
        expect(after?.last_active_at?.toISOString()).toBe("2020-01-01T00:00:00.000Z");
        expect(after?.previous_visit_at?.toISOString()).toBe("2019-01-01T00:00:00.000Z");

        await sql`
          UPDATE core.sessions SET revoked_at = now() WHERE token_hash = ${hashToken(token)}
        `;
        expect(await readSessionReauthAt(appSql, `bl_session=${token}`, "test")).toBeNull();
        expect(await readSessionReauthAt(appSql, null, "test")).toBeNull();
      } finally {
        await appSql.close();
      }
    });
  }, 15_000);
});
