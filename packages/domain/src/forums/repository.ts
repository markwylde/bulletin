import type { SQL } from "bun";
import type { CapabilityView } from "../permissions/capability.ts";

export interface VisibleForum {
  readonly id: string;
  readonly parentId: string | null;
  readonly passwordProtected: boolean;
}

interface ForumRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly password_protected: boolean;
}

function toForum(row: ForumRow): VisibleForum {
  return {
    id: row.id,
    parentId: row.parent_id,
    passwordProtected: row.password_protected,
  };
}

/**
 * The permission-filtered forum repository (ADR 0005). Every content query must live behind a
 * function that takes the viewer's capability accessor; the architecture test fails a build
 * that queries content tables anywhere else.
 */
export async function listVisibleForums(
  sql: SQL,
  capability: CapabilityView,
): Promise<readonly VisibleForum[]> {
  const rows = (await sql`
    SELECT id, parent_id, (password_hash IS NOT NULL) AS password_protected
    FROM core.forums
    ORDER BY id
  `) as ForumRow[];

  return rows.filter((row) => capability.has(row.id, "show")).map(toForum);
}

export async function readVisibleForum(
  sql: SQL,
  capability: CapabilityView,
  forumId: string,
): Promise<VisibleForum | null> {
  const [row] = (await sql`
    SELECT id, parent_id, (password_hash IS NOT NULL) AS password_protected
    FROM core.forums
    WHERE id = ${forumId}
  `) as ForumRow[];

  if (row === undefined || !capability.read(row.id)) {
    return null;
  }

  return toForum(row);
}
