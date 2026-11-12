import { banIp, banMember, listIpBans, removeIpBan, unbanMember } from "@bulletin/domain/bans";
import type { SQL } from "bun";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function listBansResponse(sql: SQL): Promise<Response> {
  return json({ ips: await listIpBans(sql) });
}

export async function mutateBanResponse(
  sql: SQL,
  actorId: string,
  request: Request,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  if (body === null || typeof body.action !== "string") {
    return json({ code: "invalid_request" }, 400);
  }

  const days = typeof body.days === "number" ? body.days : undefined;

  if (
    body.action === "ip.save" &&
    typeof body.cidr === "string" &&
    typeof body.reason === "string"
  ) {
    const result = await banIp(sql, {
      actorId,
      cidr: body.cidr,
      reason: body.reason,
      ...(days === undefined ? {} : { days }),
    });
    return result.ok ? json({ ok: true, id: result.result.id }) : json(result, 400);
  }

  if (body.action === "ip.remove" && typeof body.id === "string") {
    const result = await removeIpBan(sql, { actorId, id: body.id });
    return result.ok ? json({ ok: true, deleted: result.result.deleted }) : json(result, 403);
  }

  if (
    body.action === "member.ban" &&
    typeof body.memberId === "string" &&
    typeof body.reason === "string"
  ) {
    const result = await banMember(sql, {
      actorId,
      memberId: body.memberId,
      reason: body.reason,
      ...(days === undefined ? {} : { days }),
    });
    return result.ok
      ? json({ ok: true, id: result.result.id })
      : json(result, result.code === "already_banned" ? 409 : 400);
  }

  if (body.action === "member.unban" && typeof body.memberId === "string") {
    const result = await unbanMember(sql, { actorId, memberId: body.memberId });
    return result.ok ? json({ ok: true, restored: result.result.restored }) : json(result, 403);
  }

  return json({ code: "invalid_request" }, 400);
}
