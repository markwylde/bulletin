import { applyCacheHeaders, isNotModified, requestHasSession } from "../http/cache.ts";
import type { SeoDocument } from "./document.ts";

function hash(body: string): string {
  return `"${new Bun.CryptoHasher("sha256").update(body).digest("hex")}"`;
}

/**
 * XML responses are public documents: guests may receive them from the CDN, a request carrying
 * a session cookie is served the same guest document but never shared. A 404 is never cached.
 */
export function seoHttpResponse(
  document: SeoDocument,
  request: Request,
  options: { readonly dev: boolean; readonly nodeEnv: "development" | "test" | "production" },
): Response {
  const headers = new Headers({
    "content-type": document.contentType,
    "x-content-type-options": "nosniff",
  });

  if (document.status === 404) {
    headers.set("cache-control", "no-store");

    return new Response(document.body, { status: 404, headers });
  }

  const etag = hash(document.body);

  applyCacheHeaders(headers, {
    cdnCacheable: true,
    hasSession: requestHasSession(request.headers.get("cookie"), options.nodeEnv),
    hasUnlockGrant: false,
    tags: document.tags,
    etag,
    dev: options.dev,
    status: null,
    key: null,
  });

  if (isNotModified(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(document.body, { status: document.status, headers });
}
