import {
  deleteWarningReason,
  deleteWarningThreshold,
  listWarningReasons,
  listWarningThresholds,
  saveWarningReason,
  saveWarningThreshold,
} from "@bulletin/domain/warnings";
import type { SQL } from "bun";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function failure(code: string): Response {
  return json({ code }, code === "duplicate_reason" ? 409 : code === "not_found" ? 404 : 400);
}

export async function warningSettingsResponse(sql: SQL): Promise<Response> {
  const [reasons, thresholds] = await Promise.all([
    listWarningReasons(sql),
    listWarningThresholds(sql),
  ]);

  return json({ reasons, thresholds });
}

export async function mutateWarningSettingResponse(sql: SQL, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  if (body === null || typeof body.action !== "string") {
    return json({ code: "invalid_request" }, 400);
  }

  if (body.kind === "reason") {
    if (body.action === "delete") {
      const result = await deleteWarningReason(sql, typeof body.id === "string" ? body.id : "");
      return result.ok ? json({ ok: true, deleted: result.result.deleted }) : failure(result.code);
    }

    if (body.action === "save") {
      const result = await saveWarningReason(sql, body);
      return result.ok ? json({ ok: true, id: result.result.id }) : failure(result.code);
    }
  }

  if (body.kind === "threshold") {
    if (body.action === "delete") {
      const result = await deleteWarningThreshold(sql, typeof body.id === "string" ? body.id : "");
      return result.ok ? json({ ok: true, deleted: result.result.deleted }) : failure(result.code);
    }

    if (body.action === "save") {
      const result = await saveWarningThreshold(sql, {
        ...body,
        action: body.thresholdAction,
      });
      return result.ok ? json({ ok: true, id: result.result.id }) : failure(result.code);
    }
  }

  return json({ code: "invalid_request" }, 400);
}
