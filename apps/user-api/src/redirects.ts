import { listRedirectClickCounts } from "@bulletin/domain/forums";
import type { SQL } from "bun";

/**
 * `GET /api/forums/redirect-counts`: a small public fragment the index refreshes after paint.
 * Counters are read-path data, so this response never participates in content cache tags.
 */
export async function redirectCountsResponse(sql: SQL): Promise<Response> {
  return Response.json(
    { counts: await listRedirectClickCounts(sql) },
    { headers: { "cache-control": "no-store" } },
  );
}
