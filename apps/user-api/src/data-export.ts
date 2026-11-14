import type { AuthNodeEnv } from "@bulletin/domain/auth";
import { requestDataExport } from "@bulletin/domain/privacy";
import { PRESIGN_GET_EXPIRES_IN, type StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";
import { userSessionToken } from "./push.ts";

const NO_STORE = { "cache-control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** `POST /api/me/data-export`: one open export request per member. */
export async function requestDataExportResponse(
  sql: SQL,
  memberId: string,
  request: Request,
  nodeEnv: AuthNodeEnv,
): Promise<Response> {
  const token = userSessionToken(request, nodeEnv);

  if (token === null) {
    return json({ code: "unauthenticated" }, 401);
  }

  const requestId = await requestDataExport(sql, token, memberId);

  return requestId === null
    ? json({ code: "invalid_request" }, 400)
    : json({ requestId, status: "processing" }, 202);
}

/** `GET /api/me/data-export/<id>`: checks the member and expiry, then presigns for 60 s. */
export async function dataExportDownloadResponse(
  sql: SQL,
  storage: StorageClient,
  request: Request,
  nodeEnv: AuthNodeEnv,
  requestId: string,
): Promise<Response> {
  const token = userSessionToken(request, nodeEnv);

  if (token === null) {
    return json({ code: "unauthenticated" }, 401);
  }

  if (!/^\d+$/.test(requestId)) {
    return json({ code: "not_found" }, 404);
  }

  const [row] = (await sql`
    SELECT export_key FROM pii.export_download_target(${token}, ${requestId})
  `) as Array<{ export_key: string }>;

  if (row === undefined) {
    return json({ code: "not_found" }, 404);
  }

  const location = storage.presignGet(row.export_key, {
    expiresIn: PRESIGN_GET_EXPIRES_IN,
    responseContentType: "application/zip",
    responseContentDisposition: 'attachment; filename="bulletin-export.zip"',
  });

  return new Response(null, {
    status: 303,
    headers: { location, ...NO_STORE },
  });
}
