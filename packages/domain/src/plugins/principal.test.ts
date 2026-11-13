import { describe, expect, test } from "bun:test";
import { withTestDatabase } from "@bulletin/test-utils/database";
import { grantElevatedAccess, loadServicePrincipal, revokeElevatedAccess } from "./principal.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

integrationDescribe("plugin service principal", () => {
  test("defaults to Guests and records elevated grants with a warning", async () => {
    await withTestDatabase(
      { adminUrl: adminUrl as string, prefix: "plugin_principal" },
      async (db) => {
        await db.sql`
        INSERT INTO core.plugins (plugin_id, version, sdk_version, state, enabled)
        VALUES ('welcome-bot', '1.0.0', '^2.0.0', 'active', true)
      `;

        expect(await loadServicePrincipal(db.sql, "welcome-bot")).toEqual({
          group: "Guests",
          elevatedForumIds: [],
          warningKey: null,
        });

        const principal = await grantElevatedAccess(db.sql, {
          pluginId: "welcome-bot",
          forumIds: ["12", "12", "13", "not-a-forum"],
          actorId: "admin-1",
        });
        expect(principal).toEqual({
          group: "Guests",
          elevatedForumIds: ["12", "13"],
          warningKey: "staff.plugins.grant.warning",
        });

        const audit = (await db.sql`
        SELECT summary FROM core.system_audit_buffer WHERE action = 'plugin.elevated_grant'
      `) as Array<{ summary: { forumIds: string[]; warningKey: string; actorId: string } }>;
        expect(audit[0]?.summary).toMatchObject({
          forumIds: ["12", "13"],
          warningKey: "staff.plugins.grant.warning",
          actorId: "admin-1",
        });

        await revokeElevatedAccess(db.sql, "welcome-bot");
        expect(await loadServicePrincipal(db.sql, "welcome-bot")).toMatchObject({
          elevatedForumIds: [],
        });
      },
    );
  }, 20_000);
});
