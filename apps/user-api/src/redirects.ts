import { listRedirectClickCounts } from "@bulletin/domain/forums";
import {
  can,
  GUEST_PRINCIPAL,
  loadForumTree,
  loadPermissionSnapshot,
  type ViewerPrincipal,
} from "@bulletin/domain/permissions";
import type { SQL } from "bun";

/**
 * `GET /api/forums/redirect-counts`: a small public fragment the index refreshes after paint.
 * Only redirect forums the viewer may `show` are returned; ancestor visibility is part of the
 * compiled snapshot. Counters are read-path data and never invalidate content pages.
 */
export async function redirectCountsResponse(
  sql: SQL,
  principal: ViewerPrincipal = GUEST_PRINCIPAL,
  sessionId: string | null = null,
): Promise<Response> {
  const [tree, all] = await Promise.all([loadForumTree(sql), listRedirectClickCounts(sql)]);
  const snapshot = await loadPermissionSnapshot(sql, principal, { tree, sessionId });
  const counts: Record<string, number> = {};

  for (const [forumId, count] of Object.entries(all)) {
    if (
      await can(sql, principal, "show", {
        forumId,
        tree,
        sessionId,
        snapshot,
      })
    ) {
      counts[forumId] = count;
    }
  }

  return Response.json({ counts }, { headers: { "cache-control": "no-store" } });
}
