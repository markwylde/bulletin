import {
  isNotificationTypeValue,
  setDigestFrequency,
  setNotificationPreference,
  verifyUnsubscribeToken,
} from "@bulletin/domain/notifications";
import type { SQL } from "bun";

const NO_STORE = { "cache-control": "no-store" } as const;

export interface UnsubscribeOptions {
  readonly secret: string;
  readonly userOrigin: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/**
 * `POST /api/notifications/unsubscribe` (ADR 0018 exemption): authenticated by the signed,
 * expiring token instead of a session, so a mail client's RFC 8058 one-click POST works. A
 * browser form is redirected to the confirmation page; a one-click request gets a plain 2xx.
 */
export async function unsubscribeResponse(
  sql: SQL,
  options: UnsubscribeOptions,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  let token = url.searchParams.get("token");
  let oneClick = request.headers.get("origin") === null;
  const contentType = request.headers.get("content-type") ?? "";

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await request.formData().catch(() => null);

    if (form !== null) {
      const formToken = form.get("token");

      if (typeof formToken === "string" && formToken !== "") {
        token = formToken;
      }

      if (form.get("List-Unsubscribe") === "One-Click") {
        oneClick = true;
      }
    }
  } else {
    const text = await request.text().catch(() => "");

    if (text.trim() === "List-Unsubscribe=One-Click") {
      oneClick = true;
    }
  }

  const claims = token === null ? null : verifyUnsubscribeToken(options.secret, token);

  if (claims === null) {
    return json({ code: "invalid_token" }, 400);
  }

  if (claims.type === "digest") {
    await setDigestFrequency(sql, claims.memberId, "off");
  } else if (isNotificationTypeValue(claims.type)) {
    await setNotificationPreference(sql, claims.memberId, claims.type, "email", false);
  } else {
    return json({ code: "invalid_token" }, 400);
  }

  if (oneClick) {
    return json({ ok: true });
  }

  return new Response(null, {
    status: 303,
    headers: { location: `${options.userOrigin}/unsubscribe/confirmed`, ...NO_STORE },
  });
}
