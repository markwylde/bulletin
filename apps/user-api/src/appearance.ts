import { type AuthService, parseCookieHeader } from "@bulletin/domain/auth";
import { appearanceOptions, saveMemberAppearance } from "@bulletin/domain/themes";
import { BP_COOKIE_NAME, type ColorScheme, parseBpCookie } from "@bulletin/i18n";
import type { SQL } from "bun";

export interface SessionLike {
  readonly memberId: string;
}

function schemeOf(value: unknown): ColorScheme | null {
  return value === "light" || value === "dark" || value === "system" ? value : null;
}

/** `GET /api/theme-options`: the chooser list for this member or guest. */
export async function themeOptionsResponse(
  sql: SQL,
  request: Request,
  session: SessionLike | null,
): Promise<Response> {
  const options = await appearanceOptions(sql, session?.memberId ?? null);
  let themeId = options.themeId;
  let scheme = options.scheme;

  if (session === null) {
    const bp = parseBpCookie(parseCookieHeader(request.headers.get("cookie"))[BP_COOKIE_NAME]);
    scheme = bp.scheme;

    if (bp.themeId > 0 && options.themes.some((theme) => theme.id === String(bp.themeId))) {
      themeId = String(bp.themeId);
    }
  }

  return Response.json(
    {
      member: session !== null,
      themes: options.themes,
      themeId,
      scheme,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}

/** `POST /api/me/appearance`: the member's theme and colour-scheme choice. */
export async function saveAppearanceResponse(
  sql: SQL,
  session: SessionLike,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ code: "invalid_request" }, { status: 400 });
  }

  const record = body as Record<string, unknown>;
  const themeId =
    record.themeId === null || record.themeId === undefined
      ? null
      : typeof record.themeId === "string" && /^\d+$/.test(record.themeId)
        ? record.themeId
        : undefined;
  const scheme = schemeOf(record.scheme);

  if (themeId === undefined || scheme === null) {
    return Response.json({ code: "invalid_request" }, { status: 400 });
  }

  const outcome = await saveMemberAppearance(sql, session.memberId, { themeId, scheme });

  if (!outcome.ok) {
    return Response.json(
      { code: outcome.code },
      {
        status: outcome.code === "invalid_scheme" ? 400 : 404,
        headers: { "cache-control": "no-store" },
      },
    );
  }

  return Response.json(
    { ok: true, themeId, scheme },
    { headers: { "cache-control": "private, no-store" } },
  );
}

/**
 * `GET /api/theme-options` as a passive read: a session waiting for silent re-auth is answered
 * as a guest (200 with the guest list), never with a 401 or with its member-only themes.
 */
export async function passiveThemeOptionsResponse(
  sql: SQL,
  auth: Pick<AuthService, "passiveSession">,
  request: Request,
): Promise<Response> {
  return themeOptionsResponse(sql, request, await auth.passiveSession(request));
}
