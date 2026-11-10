import type { SQL } from "bun";
import { createForumTree, type ForumTree } from "./tree.ts";

interface ForumRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly password_protected: boolean;
}

/**
 * The permission compiler's `ForumTree` provider (ADR 0005). It reads every category and forum
 * from `core.forums`, including password forums, and validates the adjacency list so a broken
 * tree fails before it can be compiled into capability bits. The materialised `path` gives a
 * stable tree order without a recursive query.
 */
export async function loadForumTree(sql: SQL): Promise<ForumTree> {
  const rows = (await sql`
    SELECT
      id,
      parent_id,
      (password_hash IS NOT NULL) AS password_protected
    FROM core.forums
    ORDER BY path, position, id
  `) as ForumRow[];

  return createForumTree(
    rows.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      passwordProtected: row.password_protected,
    })),
  );
}
