import type { SQL } from "bun";
import { createForumTree, type ForumTree } from "./tree.ts";

interface ForumRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly password_protected: boolean;
}

/**
 * Loads the forum tree and its password flags. Change `forum-structure` owns the full forum
 * table; the permission compiler only needs the shape and whether a password is set.
 */
export async function loadForumTree(sql: SQL): Promise<ForumTree> {
  const rows = (await sql`
    SELECT id, parent_id, (password_hash IS NOT NULL) AS password_protected
    FROM core.forums
    ORDER BY id
  `) as ForumRow[];

  return createForumTree(
    rows.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      passwordProtected: row.password_protected,
    })),
  );
}
