import type { MentionedMember, MentionResolver } from "@bulletin/content";
import type { SQL } from "bun";
import { canonicalUrl } from "../urls/index.ts";

interface MemberRow {
  readonly id: string;
  readonly display_name: string;
}

function member(row: MemberRow): MentionedMember {
  return {
    id: row.id,
    displayName: row.display_name,
    url: canonicalUrl("profile", row.id, row.display_name),
  };
}

/**
 * Resolves rendered `@name` mentions against current member display names (ADR 0007). The
 * worker uses this too, so a re-render keeps the same profile links as the original save.
 */
export function createMentionResolver(sql: SQL): MentionResolver {
  return {
    async resolve(name) {
      const rows = (await sql`
        SELECT id::text AS id, display_name
        FROM core.members
        WHERE is_service = false
          AND display_name IS NOT NULL
          AND lower(display_name) = lower(${name})
        LIMIT 1
      `) as MemberRow[];

      return rows[0] === undefined ? null : member(rows[0]);
    },
    async resolveById(id) {
      if (!/^\d+$/.test(id)) {
        return null;
      }

      const rows = (await sql`
        SELECT id::text AS id, display_name
        FROM core.members
        WHERE id = ${id}
          AND is_service = false
          AND display_name IS NOT NULL
      `) as MemberRow[];

      return rows[0] === undefined ? null : member(rows[0]);
    },
  };
}
