import { hashForumPassword } from "@bulletin/domain/permissions";
import { FIXTURE_DEMO_PASSWORD } from "@bulletin/domain/permissions/fixtures";
import type { SeedModule } from "./framework.ts";

/**
 * A minimal forum tree for the permission-matrix and moderator editors until change
 * `forum-structure` lands the real forum seed. Existing forums (from a later seed) are left
 * untouched.
 */
export const permissionFixtureSeedModule: SeedModule = {
  name: "permission-fixtures",
  dependsOn: ["base"],
  async run({ sql }) {
    const existing = (await sql`SELECT 1 FROM core.forums LIMIT 1`) as unknown[];

    if (existing.length > 0) {
      return;
    }

    const [category] = (await sql`
      INSERT INTO core.forums (type, title, slug)
      VALUES ('category', 'Permission Fixtures', 'permission-fixtures')
      RETURNING id
    `) as Array<{ id: string }>;

    if (category === undefined) {
      throw new Error("Could not seed the permission fixture category");
    }

    await sql`
      INSERT INTO core.forums (parent_id, title, slug)
      VALUES (${category.id}, 'Announcements', 'announcements')
    `;

    const [general] = (await sql`
      INSERT INTO core.forums (parent_id, title, slug)
      VALUES (${category.id}, 'General Discussion', 'general-discussion')
      RETURNING id
    `) as Array<{ id: string }>;

    if (general !== undefined) {
      // The demo route renders a password-style unlock over this forum (task 4.2).
      await sql`
        UPDATE core.forums
        SET password_hash = ${await hashForumPassword(FIXTURE_DEMO_PASSWORD)}
        WHERE id = ${general.id}
      `;
      await sql`
        INSERT INTO core.forums (parent_id, title, slug)
        VALUES (${general.id}, 'Nested Forum', 'nested-forum')
      `;
    }
  },
};
