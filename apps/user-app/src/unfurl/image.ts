import { type StorageClient, unfurlImageKey } from "@bulletin/storage";

/** Content-hashed proxied images never change, so both browser and CDN may keep them. */
export const UNFURL_IMAGE_CACHE = "public, max-age=86400, immutable";
export const UNFURL_IMAGE_PRESIGN_EXPIRES_IN = 7 * 24 * 60 * 60;

/**
 * `GET /unfurl/<hash>` (task 3.2): a stable, content-hashed URL that 302s to the files origin.
 * The bytes never come from the third-party site, so the viewer's browser cannot be tracked
 * by the page that was unfurled (ADR 0019).
 */
export async function unfurlImageResponse(storage: StorageClient, hash: string): Promise<Response> {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    return Response.json(
      { code: "not_found" },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  const key = unfurlImageKey(hash);

  if (!(await storage.exists(key))) {
    return Response.json(
      { code: "not_found" },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  const location = storage.presignGet(key, {
    expiresIn: UNFURL_IMAGE_PRESIGN_EXPIRES_IN,
    responseContentType: "image/webp",
    responseContentDisposition: 'inline; filename="unfurl.webp"',
  });

  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": UNFURL_IMAGE_CACHE },
  });
}
