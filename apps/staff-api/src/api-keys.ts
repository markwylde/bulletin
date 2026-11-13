import {
  API_SCOPES,
  canonicalApiScopes,
  createIntegrationApiKey,
  isApiScope,
  listIntegrationKeys,
  revokeIntegrationApiKey,
} from "@bulletin/domain/api";
import { listMemberListGroups, validateDisplayName } from "@bulletin/domain/member";
import type { SQL } from "bun";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export async function integrationKeysResponse(sql: SQL): Promise<Response> {
  const [keys, groups] = await Promise.all([listIntegrationKeys(sql), listMemberListGroups(sql)]);

  return json({ keys, groups, scopes: API_SCOPES });
}

export async function mutateIntegrationKeyResponse(
  sql: SQL,
  actorId: string,
  request: Request,
  pepper: string,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ code: "invalid_request" }, 400);
  }

  const record = body as Record<string, unknown>;

  if (record.action === "revoke") {
    const id = typeof record.id === "string" ? record.id : "";
    return (await revokeIntegrationApiKey(sql, id))
      ? json({ ok: true })
      : json({ code: "not_found" }, 404);
  }

  if (record.action !== "create") {
    return json({ code: "invalid_request" }, 400);
  }

  const name = validateDisplayName(record.label);
  const groupIds = [...new Set(strings(record.groupIds))];
  const rawScopes = strings(record.scopes);
  const scopes = canonicalApiScopes(rawScopes);

  if (
    !name.ok ||
    groupIds.length === 0 ||
    groupIds.some((id) => !/^\d+$/.test(id)) ||
    rawScopes.length === 0 ||
    scopes.length !== new Set(rawScopes).size ||
    !rawScopes.every(isApiScope)
  ) {
    return json({ code: "invalid_request" }, 400);
  }

  let expiresAt: Date | null = null;

  if (record.expiresAt !== undefined && record.expiresAt !== null) {
    if (typeof record.expiresAt !== "string") {
      return json({ code: "invalid_request" }, 400);
    }

    const parsed = new Date(record.expiresAt);

    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      return json({ code: "invalid_request" }, 400);
    }

    expiresAt = parsed;
  }

  try {
    const created = await createIntegrationApiKey(sql, {
      label: name.name,
      groupIds,
      scopes,
      expiresAt,
      pepper,
    });

    return json({
      ok: true,
      key: created.key,
      metadata: { ...created.metadata, principalName: name.name },
      actorId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";

    return message.includes("duplicate") || message.includes("unique")
      ? json({ code: "display_name_taken" }, 409)
      : json({ code: "invalid_request" }, 400);
  }
}
