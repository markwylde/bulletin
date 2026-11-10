import { suggestMembers } from "@bulletin/domain/member";
import type { SQL } from "bun";

/** `GET /api/members/suggest?q=jo` backs the editor's mention autocomplete (max 8). */
export async function memberSuggestResponse(sql: SQL, url: URL): Promise<Response> {
  const query = url.searchParams.get("q") ?? "";

  return Response.json(
    { members: await suggestMembers(sql, query) },
    { headers: { "cache-control": "no-store" } },
  );
}
