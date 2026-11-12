import {
  deleteFilterDomain,
  deleteFilterWord,
  listFilterDomains,
  listFilterWords,
  readFilterSettings,
  saveFilterDomain,
  saveFilterSettings,
  saveFilterWord,
} from "@bulletin/domain/filters";
import type { SQL } from "bun";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function filterSettingsResponse(sql: SQL): Promise<Response> {
  const [words, domains, settings] = await Promise.all([
    listFilterWords(sql),
    listFilterDomains(sql),
    readFilterSettings(sql),
  ]);

  return json({ words, domains, settings });
}

export async function mutateFilterResponse(sql: SQL, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  if (body === null || typeof body.action !== "string") {
    return json({ code: "invalid_request" }, 400);
  }

  if (body.kind === "word") {
    if (body.action === "delete") {
      return json(await deleteFilterWord(sql, typeof body.id === "string" ? body.id : ""));
    }

    if (body.action === "save") {
      const result = await saveFilterWord(sql, body);
      return result.ok ? json({ ok: true, id: result.id }) : json(result, 400);
    }
  }

  if (body.kind === "domain") {
    if (body.action === "delete") {
      return json(await deleteFilterDomain(sql, typeof body.id === "string" ? body.id : ""));
    }

    if (body.action === "save") {
      const result = await saveFilterDomain(sql, body);
      return result.ok ? json({ ok: true, id: result.id }) : json(result, 400);
    }
  }

  if (body.kind === "settings" && body.action === "save") {
    const settings = await saveFilterSettings(sql, body);
    return settings === null
      ? json({ code: "invalid_request" }, 400)
      : json({ ok: true, settings });
  }

  return json({ code: "invalid_request" }, 400);
}
