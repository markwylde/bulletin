import {
  API_SCOPES,
  canonicalApiScopes,
  createPersonalApiKey,
  isApiScope,
  listApiKeys,
  revokeApiKey,
} from "@bulletin/domain/api";
import { can } from "@bulletin/domain/permissions";
import type { SQL } from "bun";

const MAX_LABEL = 100;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function bodyRecord(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);

  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

async function allowed(sql: SQL, memberId: string): Promise<boolean> {
  return can(sql, memberId, "create_personal_api_keys");
}

/** `GET /api/me/api-keys`: the member's own key metadata, never the key values. */
export async function personalApiKeysResponse(sql: SQL, memberId: string): Promise<Response> {
  if (!(await allowed(sql, memberId))) {
    return json({ code: "not_found" }, 404);
  }

  return json({ keys: await listApiKeys(sql, memberId), scopes: API_SCOPES });
}

/** `POST /api/me/api-keys`: creates one personal key and returns it once. */
export async function createPersonalApiKeyResponse(
  sql: SQL,
  memberId: string,
  request: Request,
  pepper: string,
): Promise<Response> {
  if (!(await allowed(sql, memberId))) {
    return json({ code: "not_found" }, 404);
  }

  const body = await bodyRecord(request);

  if (body === null) {
    return json({ code: "invalid_request" }, 400);
  }

  const label = typeof body.label === "string" ? body.label.trim() : "";
  const rawScopes = Array.isArray(body.scopes)
    ? body.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  const scopes = canonicalApiScopes(rawScopes);

  if (
    label === "" ||
    label.length > MAX_LABEL ||
    rawScopes.length === 0 ||
    scopes.length !== new Set(rawScopes).size ||
    !rawScopes.every(isApiScope)
  ) {
    return json({ code: "invalid_request" }, 400);
  }

  let expiresAt: Date | null = null;

  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    if (typeof body.expiresAt !== "string") {
      return json({ code: "invalid_request" }, 400);
    }

    const parsed = new Date(body.expiresAt);

    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      return json({ code: "invalid_request" }, 400);
    }

    expiresAt = parsed;
  }

  const created = await createPersonalApiKey(sql, {
    memberId,
    label,
    scopes,
    expiresAt,
    pepper,
  });

  return json({ ok: true, key: created.key, metadata: created.metadata });
}

/** `POST /api/me/api-keys/revoke`: revokes only a key belonging to this member. */
export async function revokePersonalApiKeyResponse(
  sql: SQL,
  memberId: string,
  request: Request,
): Promise<Response> {
  if (!(await allowed(sql, memberId))) {
    return json({ code: "not_found" }, 404);
  }

  const body = await bodyRecord(request);
  const id = body !== null && typeof body.id === "string" ? body.id : "";

  if (!/^\d+$/.test(id)) {
    return json({ code: "invalid_request" }, 400);
  }

  return (await revokeApiKey(sql, { keyId: id, principalMemberId: memberId }))
    ? json({ ok: true })
    : json({ code: "not_found" }, 404);
}
