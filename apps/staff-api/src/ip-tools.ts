import { parseCookieHeader, sessionCookieName } from "@bulletin/domain/auth";
import { writeModerationLog } from "@bulletin/domain/moderation";
import {
  type IpAccessPurpose,
  openIpAccess,
  readLoginIps,
  readMembersByIp,
  readPostIp,
} from "@bulletin/domain/pii";
import type { SQL } from "bun";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function staffSessionToken(request: Request): string | null {
  const env = process.env.NODE_ENV === "production" ? "production" : "development";
  return parseCookieHeader(request.headers.get("cookie"))[sessionCookieName("staff", env)] ?? null;
}

export async function openIpAccessResponse(
  sql: SQL,
  actorId: string,
  request: Request,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  if (
    body === null ||
    (body.purpose !== "post_ip" && body.purpose !== "reverse_ip" && body.purpose !== "login_ips") ||
    (body.resourceType !== "post" && body.resourceType !== "member") ||
    typeof body.resourceId !== "string" ||
    !/^\d+$/.test(body.resourceId)
  ) {
    return json({ code: "invalid_request" }, 400);
  }

  const token = staffSessionToken(request);

  if (token === null) {
    return json({ code: "unauthenticated" }, 401);
  }

  const grantId = await openIpAccess(sql, {
    sessionToken: token,
    purpose: body.purpose as IpAccessPurpose,
    resourceType: body.resourceType,
    resourceId: body.resourceId,
  });

  if (grantId === null) {
    return json({ code: "forbidden" }, 403);
  }

  await writeModerationLog(sql, {
    actorId,
    action: "ip.lookup",
    targetType: body.resourceType,
    targetId: body.resourceId,
    details: { purpose: body.purpose, grantId },
  });

  return json({ grantId });
}

export async function readIpAccessResponse(sql: SQL, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  if (
    body === null ||
    typeof body.grantId !== "string" ||
    (body.kind !== "post" && body.kind !== "members" && body.kind !== "logins")
  ) {
    return json({ code: "invalid_request" }, 400);
  }

  const token = staffSessionToken(request);

  if (token === null) {
    return json({ code: "unauthenticated" }, 401);
  }

  if (body.kind === "post") {
    const result = await readPostIp(sql, token, body.grantId);
    return result === null ? json({ code: "not_found" }, 404) : json(result);
  }

  if (body.kind === "members") {
    return json({
      members: (await readMembersByIp(sql, token, body.grantId)).map((member) => ({
        ...member,
        createdAt: member.createdAt.toISOString(),
      })),
    });
  }

  return json({
    logins: (await readLoginIps(sql, token, body.grantId)).map((login) => ({
      ip: login.ip,
      createdAt: login.createdAt.toISOString(),
    })),
  });
}
