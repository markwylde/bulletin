import { clientIp } from "@bulletin/domain/auth";
import { isIpBanned } from "@bulletin/domain/bans";
import type { SQL } from "bun";

/**
 * The posting IP-ban guard shared by the browser endpoints and `/api/v1` writes. Keeping it
 * outside the domain mutation mirrors the app's request path and prevents the public API from
 * becoming a bypass.
 */
export async function blockedPostingResponse(sql: SQL, request: Request): Promise<Response | null> {
  if (await isIpBanned(sql, clientIp(request))) {
    return Response.json({ code: "ip_banned" }, { status: 403 });
  }

  return null;
}
