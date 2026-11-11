import type { SessionRecord } from "@bulletin/domain/auth";
import { editableProfileFieldIds } from "@bulletin/domain/permissions";
import { readProfileFields, saveMemberProfile } from "@bulletin/domain/profiles";
import type { SQL } from "bun";

const NO_STORE = { "cache-control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `POST /api/me/profile`: the member's about text, custom fields and privacy options. Only
 * fields their groups may edit are accepted; anything else is a 403 (profile spec).
 */
export interface ProfileSaveFeatures {
  readonly customFields: boolean;
  readonly signatures: boolean;
  readonly customTitles: boolean;
  readonly badges: boolean;
}

export async function profileSaveResponse(
  sql: SQL,
  session: SessionRecord,
  request: Request,
  features: ProfileSaveFeatures = {
    customFields: true,
    signatures: true,
    customTitles: true,
    badges: true,
  },
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body) || typeof body.about !== "string" || !isRecord(body.values ?? {})) {
    return json({ code: "invalid" }, 400);
  }

  const editable = features.customFields
    ? await editableProfileFieldIds(sql, session.memberId)
    : new Set<string>();
  const fields = (await readProfileFields(sql, editable)).filter((field) => editable.has(field.id));
  const result = await saveMemberProfile(sql, {
    memberId: session.memberId,
    aboutMd: body.about,
    hideOnline: body.hideOnline === true,
    hideFromMemberList: body.hideFromMemberList === true,
    ...(typeof body.hideSignatures === "boolean" ? { hideSignatures: body.hideSignatures } : {}),
    ...(typeof body.hideFriends === "boolean" ? { hideFriends: body.hideFriends } : {}),
    ...(features.signatures && typeof body.signatureMd === "string"
      ? { signatureMd: body.signatureMd }
      : {}),
    ...(features.customTitles && typeof body.customTitle === "string"
      ? { customTitle: body.customTitle }
      : {}),
    ...(features.badges &&
    Array.isArray(body.featuredBadges) &&
    body.featuredBadges.every((id) => typeof id === "string" && /^\d+$/.test(id))
      ? { featuredBadges: body.featuredBadges as string[] }
      : {}),
    values: (body.values ?? {}) as Record<string, unknown>,
    fields,
  });

  if (result.ok) {
    return json({ ok: true });
  }

  const details = {
    ...(result.fieldId === undefined ? {} : { fieldId: result.fieldId }),
    ...(result.limit === undefined ? {} : { limit: result.limit }),
  };

  switch (result.code) {
    case "required":
    case "invalid":
    case "signature_too_long":
    case "signature_too_many_lines":
    case "signature_too_many_images":
    case "signature_too_many_links":
    case "custom_title_too_long":
    case "blocked_word":
    case "too_many_featured":
      return json({ code: result.code, ...details }, 400);
    case "signature_disabled":
    case "custom_title_not_allowed":
      return json({ code: result.code }, 403);
    case "not_editable":
    case "unknown_field":
      return json({ code: "not_editable", ...details }, 403);
  }
}
