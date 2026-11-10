/**
 * The forum tree the permission compiler needs (ADR 0005). Change `groups-permissions` defines
 * the interface and a fixture provider; `forum-structure` supplies the real provider.
 * IDs are strings because Postgres `bigint` values are read as strings (ADR 0001).
 */
export interface ForumNode {
  readonly id: string;
  readonly parentId: string | null;
  /** Password-protected forums additionally require a session unlock to read (ADR 0005). */
  readonly passwordProtected: boolean;
}

export interface ForumTree {
  readonly ids: readonly string[];
  readonly roots: readonly ForumNode[];
  get(id: string): ForumNode | undefined;
  /** The path from the root to the node, including the node. Empty when unknown. */
  lineage(id: string): readonly ForumNode[];
  /** Every ancestor, root first. Empty for a root or an unknown forum. */
  ancestors(id: string): readonly ForumNode[];
  /** Every descendant in breadth-first order, excluding the node. */
  descendants(id: string): readonly ForumNode[];
}

export class ForumTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForumTreeError";
  }
}

function indexNodes(nodes: readonly ForumNode[]): Map<string, ForumNode> {
  const byId = new Map<string, ForumNode>();

  for (const node of nodes) {
    if (node.id.trim() === "") {
      throw new ForumTreeError("Forum id must not be empty");
    }

    if (byId.has(node.id)) {
      throw new ForumTreeError(`Duplicate forum id ${node.id}`);
    }

    byId.set(node.id, node);
  }

  for (const node of nodes) {
    if (node.parentId !== null && !byId.has(node.parentId)) {
      throw new ForumTreeError(`Forum ${node.id} has missing parent ${node.parentId}`);
    }

    if (node.parentId === node.id) {
      throw new ForumTreeError(`Forum ${node.id} cannot be its own parent`);
    }
  }

  for (const node of nodes) {
    const seen = new Set<string>();
    let current: ForumNode | undefined = node;

    while (current !== undefined) {
      if (seen.has(current.id)) {
        throw new ForumTreeError(`Forum tree cycle at ${current.id}`);
      }

      seen.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }

  return byId;
}

/** Builds a validated, read-only forum tree. Throws `ForumTreeError` on bad input. */
export function createForumTree(nodes: readonly ForumNode[]): ForumTree {
  const byId = indexNodes(nodes);
  const ordered = [...nodes];

  const lineageCache = new Map<string, readonly ForumNode[]>();
  const children = new Map<string, ForumNode[]>();

  for (const node of ordered) {
    if (node.parentId === null) {
      continue;
    }

    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }

  function lineage(id: string): readonly ForumNode[] {
    const cached = lineageCache.get(id);

    if (cached !== undefined) {
      return cached;
    }

    const path: ForumNode[] = [];
    let current = byId.get(id);

    while (current !== undefined) {
      path.push(current);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }

    path.reverse();
    lineageCache.set(id, path);
    return path;
  }

  return {
    ids: ordered.map((node) => node.id),
    roots: ordered.filter((node) => node.parentId === null),
    get(id) {
      return byId.get(id);
    },
    lineage,
    ancestors(id) {
      return lineage(id).slice(0, -1);
    },
    descendants(id) {
      if (!byId.has(id)) {
        return [];
      }

      const result: ForumNode[] = [];
      const queue = [...(children.get(id) ?? [])];

      while (queue.length > 0) {
        const node = queue.shift();

        if (node === undefined) {
          continue;
        }

        result.push(node);
        queue.push(...(children.get(node.id) ?? []));
      }

      return result;
    },
  };
}
