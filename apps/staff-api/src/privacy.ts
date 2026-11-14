import {
  type AccessLogFilters,
  type DataRequestFilters,
  listDataRequests,
  openAccessLog,
  readAccessLog,
  setDataRequestPostAction,
  updateDataRequest,
} from "@bulletin/domain/pii";
import {
  type PrivacySettings,
  parsePrivacySettingsInput,
  readPrivacyPolicy,
  readPrivacySettings,
  savePrivacyPolicy,
} from "@bulletin/domain/privacy";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";
import { staffSessionToken } from "./ip-tools.ts";

export type PrivacySettingsSaveResult =
  | { readonly ok: true; readonly settings: PrivacySettings }
  | { readonly ok: false; readonly fields: readonly string[] };

export async function loadPrivacyRetention(sql: SQL): Promise<PrivacySettings> {
  return readPrivacySettings(sql);
}

export async function savePrivacyRetention(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<PrivacySettingsSaveResult> {
  const parsed = parsePrivacySettingsInput(input);

  if (!parsed.ok) {
    return { ok: false, fields: parsed.fields };
  }

  const value = parsed.value;
  const settings = await sql.begin(async (tx) => {
    await tx`SELECT 1 FROM core.privacy_settings WHERE id = 1 FOR UPDATE`;
    const before = await readPrivacySettings(tx);

    await tx`
      INSERT INTO core.privacy_settings (
        id, ip_log_retention_days, session_meta_retention_days,
        revoked_session_retention_days, access_log_retention_days,
        export_retention_days, ip_ban_retention_days, updated_at
      )
      VALUES (
        1, ${value.ipLogDays}, ${value.sessionMetaDays}, ${value.revokedSessionDays},
        ${value.accessLogDays}, ${value.exportDays}, ${value.ipBanDays}, now()
      )
      ON CONFLICT (id) DO UPDATE
      SET ip_log_retention_days = EXCLUDED.ip_log_retention_days,
          session_meta_retention_days = EXCLUDED.session_meta_retention_days,
          revoked_session_retention_days = EXCLUDED.revoked_session_retention_days,
          access_log_retention_days = EXCLUDED.access_log_retention_days,
          export_retention_days = EXCLUDED.export_retention_days,
          ip_ban_retention_days = EXCLUDED.ip_ban_retention_days,
          updated_at = now()
    `;

    const after = await readPrivacySettings(tx);

    await writeAdminLog(tx, {
      actorMemberId,
      action: "privacy.retention.update",
      targetType: "privacy_settings",
      targetId: "1",
      summary: { before, after },
    });

    return after;
  });

  return { ok: true, settings };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function memberNames(sql: SQL, ids: readonly string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) {
    return new Map();
  }

  const rows = (await sql`
    SELECT id::text AS id, display_name
    FROM core.members
    WHERE id = ANY(${`{${[...new Set(ids)].join(",")}}`}::bigint[])
  `) as Array<{ id: string; display_name: string | null }>;

  return new Map(rows.map((row) => [row.id, row.display_name]));
}

export async function dataRequestsResponse(sql: SQL, request: Request): Promise<Response> {
  const token = staffSessionToken(request);

  if (token === null) {
    return json({ code: "unauthenticated" }, 401);
  }

  const url = new URL(request.url);
  const filters: DataRequestFilters = {
    ...(url.searchParams.get("status") === null
      ? {}
      : { status: url.searchParams.get("status") ?? "" }),
    ...(url.searchParams.get("kind") === null ? {} : { kind: url.searchParams.get("kind") ?? "" }),
    ...(url.searchParams.get("memberId") === null
      ? {}
      : { memberId: url.searchParams.get("memberId") ?? "" }),
    ...(url.searchParams.get("overdue") === null
      ? {}
      : { overdue: url.searchParams.get("overdue") === "true" }),
  };
  const requests = await listDataRequests(sql, token, filters);
  const names = await memberNames(
    sql,
    requests.map((entry) => entry.memberId),
  );

  return json({
    requests: requests.map((entry) => ({
      ...entry,
      memberName: names.get(entry.memberId) ?? null,
      lastError: entry.lastError,
      createdAt: entry.createdAt.toISOString(),
      updatedAt: entry.updatedAt.toISOString(),
      dueAt: entry.dueAt.toISOString(),
      completedAt: entry.completedAt?.toISOString() ?? null,
    })),
  });
}

export async function updateDataRequestResponse(
  sql: SQL,
  actorId: string,
  request: Request,
): Promise<Response> {
  const token = staffSessionToken(request);
  const body: unknown = await request.json().catch(() => null);

  if (token === null) {
    return json({ code: "unauthenticated" }, 401);
  }

  if (
    !isRecord(body) ||
    typeof body.id !== "string" ||
    !/^\d+$/.test(body.id) ||
    (body.action !== "process" && body.action !== "reject" && body.action !== "complete")
  ) {
    return json({ code: "invalid_request" }, 400);
  }

  const action = body.action;
  const reason =
    typeof body.reason === "string" && body.reason.trim() !== "" ? body.reason.trim() : null;

  if (action === "reject" && reason === null) {
    return json({ code: "reason_required" }, 400);
  }

  if (
    body.postAction !== undefined &&
    body.postAction !== "anonymise" &&
    body.postAction !== "delete"
  ) {
    return json({ code: "invalid_request" }, 400);
  }

  if (body.postAction !== undefined) {
    const updated = await setDataRequestPostAction(sql, token, body.id, body.postAction);

    if (!updated) {
      return json({ code: "not_found" }, 404);
    }
  }

  await updateDataRequest(sql, token, body.id, action, reason);
  await writeAdminLog(sql, {
    actorMemberId: actorId,
    action: `privacy.request.${action}`,
    targetType: "data_request",
    targetId: body.id,
    summary: { postAction: body.postAction ?? null },
  });

  return json({ ok: true });
}

export async function accessLogResponse(sql: SQL, request: Request): Promise<Response> {
  const token = staffSessionToken(request);

  if (token === null) {
    return json({ code: "unauthenticated" }, 401);
  }

  const url = new URL(request.url);
  const filters: AccessLogFilters = {
    ...(url.searchParams.get("actorId") === null
      ? {}
      : { actorMemberId: url.searchParams.get("actorId") ?? "" }),
    ...(url.searchParams.get("subjectId") === null
      ? {}
      : { subjectMemberId: url.searchParams.get("subjectId") ?? "" }),
    ...(url.searchParams.get("purpose") === null
      ? {}
      : { purpose: url.searchParams.get("purpose") ?? "" }),
    ...(url.searchParams.get("from") === null ? {} : { from: url.searchParams.get("from") ?? "" }),
    ...(url.searchParams.get("to") === null ? {} : { to: url.searchParams.get("to") ?? "" }),
    limit: 200,
  };
  const grantId = await openAccessLog(sql, token);

  if (grantId === null) {
    return json({ code: "forbidden" }, 403);
  }

  const entries = await readAccessLog(sql, token, grantId, filters);
  const ids = entries.flatMap((entry) =>
    [entry.actorMemberId, entry.subjectMemberId].filter((id): id is string => id !== null),
  );
  const names = await memberNames(sql, ids);

  return json({
    entries: entries.map((entry) => ({
      ...entry,
      actorName: entry.actorMemberId === null ? null : (names.get(entry.actorMemberId) ?? null),
      subjectName:
        entry.subjectMemberId === null ? null : (names.get(entry.subjectMemberId) ?? null),
      createdAt: entry.createdAt.toISOString(),
    })),
  });
}

export async function privacyPolicyResponse(sql: SQL): Promise<Response> {
  return json(await readPrivacyPolicy(sql));
}

export async function updatePrivacyPolicyResponse(
  sql: SQL,
  actorId: string,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body) || typeof body.markdown !== "string" || body.markdown.length > 100_000) {
    return json({ code: "invalid_request" }, 400);
  }

  const policy = await savePrivacyPolicy(sql, actorId, body.markdown);
  await writeAdminLog(sql, {
    actorMemberId: actorId,
    action: "privacy.policy.update",
    targetType: "privacy_settings",
    targetId: "1",
    summary: { characters: body.markdown.length },
  });

  return json(policy);
}
