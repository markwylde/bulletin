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
export async function profileSaveResponse(
  sql: SQL,
  session: SessionRecord,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body) || typeof body.about !== "string" || !isRecord(body.values ?? {})) {
    return json({ code: "invalid" }, 400);
  }

  const editable = await editableProfileFieldIds(sql, session.memberId);
  const fields = (await readProfileFields(sql, editable)).filter((field) => editable.has(field.id));
  const result = await saveMemberProfile(sql, {
    memberId: session.memberId,
    aboutMd: body.about,
    hideOnline: body.hideOnline === true,
    hideFromMemberList: body.hideFromMemberList === true,
    values: (body.values ?? {}) as Record<string, unknown>,
    fields,
  });

  if (result.ok) {
    return json({ ok: true });
  }

  switch (result.code) {
    case "required":
    case "invalid":
      return json(
        { code: result.code, ...(result.fieldId === undefined ? {} : { fieldId: result.fieldId }) },
        400,
      );
    case "not_editable":
    case "unknown_field":
      return json(
        {
          code: "not_editable",
          ...(result.fieldId === undefined ? {} : { fieldId: result.fieldId }),
        },
        403,
      );
  }
}
