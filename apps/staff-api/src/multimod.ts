import {
  deleteMultimodAction,
  listMultimodActions,
  listServiceMembers,
  saveMultimodAction,
} from "@bulletin/domain/topics";
import type { SQL } from "bun";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function listMultimodForStaff(sql: SQL): Promise<Response> {
  return json({
    actions: (await listMultimodActions(sql)).map((action) => ({
      ...action,
      createdAt: action.createdAt.toISOString(),
      updatedAt: action.updatedAt.toISOString(),
    })),
  });
}

export async function listServiceMembersForStaff(sql: SQL): Promise<Response> {
  return json({ members: await listServiceMembers(sql) });
}

export async function mutateMultimodForStaff(
  sql: SQL,
  actorId: string,
  request: Request,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  if (body === null || typeof body.action !== "string") {
    return json({ code: "invalid_request" }, 400);
  }

  if (body.action === "delete") {
    const result = await deleteMultimodAction(sql, typeof body.id === "string" ? body.id : "");

    if (!result.ok) {
      return json({ code: result.code }, result.code === "not_found" ? 404 : 400);
    }

    return json({ ok: true, deleted: result.result.deleted });
  }

  if (body.action !== "save") {
    return json({ code: "invalid_request" }, 400);
  }

  const result = await saveMultimodAction(sql, actorId, body);

  if (!result.ok) {
    return json(
      { code: result.code },
      result.code === "duplicate_name" ? 409 : result.code === "not_found" ? 404 : 400,
    );
  }

  return json({ ok: true, id: result.result.id });
}
