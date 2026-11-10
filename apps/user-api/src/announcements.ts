import { dismissAnnouncement } from "@bulletin/domain/permissions";
import type { SQL } from "bun";

const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * `POST /api/announcements/<id>/dismiss` (ADR 0006): stores the dismissal version for the
 * current member. The shared page HTML never carries dismissal state; the overlay applies it.
 */
export async function announceDismissResponse(
  sql: SQL,
  memberId: string,
  announcementId: string,
): Promise<Response> {
  const result = await dismissAnnouncement(sql, memberId, announcementId);

  switch (result) {
    case "ok":
      return Response.json({ dismissed: true }, { headers: NO_STORE });
    case "not_dismissible":
      return Response.json({ code: "not_dismissible" }, { status: 409, headers: NO_STORE });
    case "not_found":
      return Response.json({ code: "not_found" }, { status: 404, headers: NO_STORE });
  }
}
