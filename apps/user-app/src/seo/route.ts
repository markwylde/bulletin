import { readSql } from "../db.ts";
import type { SeoDocument } from "./document.ts";
import { seoHttpResponse } from "./http.ts";

/** Shared endpoint plumbing: one SQL handle per process, the public origin and cache headers. */
export async function seoRoute(
  request: Request,
  load: (input: { readonly origin: string }) => Promise<SeoDocument>,
): Promise<Response> {
  const origin = new URL(request.url).origin;
  const document = await load({ origin });

  return seoHttpResponse(document, request, {
    dev: import.meta.env.DEV,
    nodeEnv: process.env.NODE_ENV === "production" ? "production" : "development",
  });
}

/** Sitemap page numbers are positive integers; anything else is an out-of-range page. */
export function parseSitemapPage(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,6}$/.test(value)) {
    return null;
  }

  const page = Number(value);

  return Number.isSafeInteger(page) && page >= 1 ? page : null;
}

export { readSql };
