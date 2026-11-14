/** A generated XML document plus the surrogate keys a CDN purge should invalidate. */
export interface SeoDocument {
  readonly status: 200 | 404 | 503;
  readonly body: string;
  readonly contentType: string;
  readonly tags: readonly string[];
}

export const SITEMAP_CONTENT_TYPE = "application/xml; charset=utf-8";

export function notFoundDocument(): SeoDocument {
  return { status: 404, body: "", contentType: "text/plain; charset=utf-8", tags: [] };
}

/** The board is offline for guests: temporary, never cached, crawlers retry later. */
export function unavailableDocument(): SeoDocument {
  return { status: 503, body: "", contentType: "text/plain; charset=utf-8", tags: [] };
}
