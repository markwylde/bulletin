import { loadFlagViewer, loadStoredFlags } from "@bulletin/db/flags";
import { dismissAnnouncement } from "@bulletin/domain/permissions";
import { evaluateFlag } from "@bulletin/flags";
import type { SQL } from "bun";

const NO_STORE = { "cache-control": "no-store" } as const;

async function announcementsEnabled(sql: SQL, memberId: string): Promise<boolean> {
  const [definitions, viewer] = await Promise.all([
    loadStoredFlags(sql),
    loadFlagViewer(sql, memberId),
  ]);
  const definition = definitions.find((candidate) => candidate.key === "announcements");

  return definition !== undefined && evaluateFlag(definition, viewer);
}

/**
 * `POST /api/announcements/<id>/dismiss` (ADR 0006): stores the dismissal version for the
 * current member. The shared page HTML never carries dismissal state; the overlay applies it.
 */
export async function announceDismissResponse(
  sql: SQL,
  memberId: string,
  announcementId: string,
): Promise<Response> {
  if (!(await announcementsEnabled(sql, memberId))) {
    return Response.json({ code: "not_found" }, { status: 404, headers: NO_STORE });
  }

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
