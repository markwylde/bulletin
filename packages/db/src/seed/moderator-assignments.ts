import { MODERATOR_POWERS } from "@bulletin/domain/permissions";
import type { SQL } from "bun";
import type { SeedModule } from "./framework.ts";

async function memberForSub(sql: SQL, sub: string): Promise<string | null> {
  const [row] = (await sql`
    SELECT member_id
    FROM pii.identities
    WHERE sub = ${sub}
    LIMIT 1
  `) as Array<{ member_id: string }>;
  return row?.member_id ?? null;
}

async function forumAt(sql: SQL, index: number): Promise<string | null> {
  const rows = (await sql`
    SELECT id FROM core.forums ORDER BY id
  `) as Array<{ id: string }>;
  return rows[index]?.id ?? null;
}

const MEMBER_MOD_POWERS = MODERATOR_POWERS.filter((power) =>
  ["edit", "soft_delete", "approve", "see_unapproved", "pin", "lock"].includes(power),
);

/**
 * The seeded moderator assignments: `forum-mod` is a member-specific moderator whose powers
 * reach sub-forums, while `member-mod` gets a "this forum only" assignment through the
 * Moderators group (ADR 0004 profiles, ADR 0005 moderators).
 */
export const moderatorAssignmentsSeedModule: SeedModule = {
  name: "moderator-assignments",
  dependsOn: ["members", "groups", "permission-fixtures"],
  async run({ sql }) {
    const forumMod = await memberForSub(sql, "forum-mod");
    const memberMod = await memberForSub(sql, "member-mod");
    const [moderatorsGroup] = (await sql`
      SELECT id FROM core.groups WHERE key = 'moderators'
    `) as Array<{ id: string }>;
    const forumWithChildren = await forumAt(sql, 2);
    const memberForum = await forumAt(sql, 1);

    if (forumMod !== null && forumWithChildren !== null) {
      await sql`
        DELETE FROM core.moderators
        WHERE forum_id = ${forumWithChildren} AND member_id = ${forumMod}
      `;
      await sql`
        INSERT INTO core.moderators (forum_id, member_id, powers, this_forum_only)
        VALUES (
          ${forumWithChildren},
          ${forumMod},
          ${`{${MODERATOR_POWERS.join(",")}}`}::text[],
          false
        )
      `;
    }

    if (memberMod !== null && moderatorsGroup !== undefined && memberForum !== null) {
      await sql`
        DELETE FROM core.moderators
        WHERE forum_id = ${memberForum} AND group_id = ${moderatorsGroup.id}
      `;
      await sql`
        INSERT INTO core.moderators (forum_id, group_id, powers, this_forum_only)
        VALUES (
          ${memberForum},
          ${moderatorsGroup.id},
          ${`{${MEMBER_MOD_POWERS.join(",")}}`}::text[],
          true
        )
      `;
    }
  },
};
