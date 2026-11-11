import type { UnfurlPreview } from "@bulletin/content/types";
import { hashUnfurlUrl, normaliseUnfurlUrl } from "@bulletin/content/unfurls";
import type { SQL } from "bun";
import { parse } from "parse5";
import {
  createSafeFetch,
  type SafeFetch,
  SafeFetchError,
  safeFetchDevAllowlist,
} from "../net/index.ts";

const PAGE_MAX_BYTES = 1024 * 1024;
const PAGE_TIMEOUT_MS = 5_000;
const PAGE_MAX_REDIRECTS = 3;
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;

export type UnfurlStatus = "pending" | "ready" | "blocked" | "failed";

export interface UnfurlRecord {
  readonly urlHash: string;
  readonly url: string;
  readonly status: UnfurlStatus;
  readonly preview: UnfurlPreview | null;
  readonly fetchedAt: Date | null;
  readonly updatedAt: Date;
}

export type UnfurlFetchResult =
  | { readonly kind: "preview"; readonly preview: UnfurlPreview }
  | { readonly kind: "blocked"; readonly error: string }
  | { readonly kind: "failed"; readonly code: string };

export interface UnfurlFetchOptions {
  readonly fetch?: SafeFetch;
  readonly now?: Date;
}

interface P5Node {
  readonly nodeName: string;
  readonly value?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly P5Node[];
}

interface PageMetadata {
  readonly ogTitle: string | null;
  readonly twitterTitle: string | null;
  readonly htmlTitle: string | null;
  readonly ogDescription: string | null;
  readonly htmlDescription: string | null;
  readonly twitterDescription: string | null;
  readonly siteName: string | null;
  readonly imageUrl: string | null;
  readonly oembedUrl: string | null;
}

function defaultFetch(): SafeFetch {
  return createSafeFetch({
    devAllow: safeFetchDevAllowlist(),
    maxBytes: PAGE_MAX_BYTES,
    timeoutMs: PAGE_TIMEOUT_MS,
    maxRedirects: PAGE_MAX_REDIRECTS,
  });
}

function walk(node: P5Node, visit: (node: P5Node) => void): void {
  visit(node);

  for (const child of node.childNodes ?? []) {
    walk(child, visit);
  }
}

function attribute(node: P5Node, name: string): string | null {
  return node.attrs?.find((attr) => attr.name.toLowerCase() === name)?.value ?? null;
}

function textOf(node: P5Node): string {
  let text = node.value ?? "";

  for (const child of node.childNodes ?? []) {
    text += textOf(child);
  }

  return text.trim();
}

function absolute(value: string | null, base: string): string | null {
  if (value === null) {
    return null;
  }

  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function truncate(value: string | null, max: number): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

function metadata(html: string, pageUrl: string): PageMetadata {
  const document = parse(html) as unknown as P5Node;
  const openGraph = new Map<string, string>();
  const twitter = new Map<string, string>();
  let title: string | null = null;
  let description: string | null = null;
  let oembedUrl: string | null = null;

  walk(document, (node) => {
    if (node.nodeName === "title" && title === null) {
      title = textOf(node);
    }

    if (node.nodeName === "meta") {
      const property = attribute(node, "property")?.toLowerCase() ?? null;
      const name = attribute(node, "name")?.toLowerCase() ?? null;
      const content = attribute(node, "content");

      if (content === null) {
        return;
      }

      if (property !== null) {
        openGraph.set(property, content);
      }

      if (name !== null) {
        if (name === "description" && description === null) {
          description = content;
        }

        twitter.set(name, content);
      }
    }

    if (node.nodeName === "link") {
      const rel = attribute(node, "rel")?.toLowerCase() ?? "";
      const type = attribute(node, "type")?.toLowerCase() ?? "";
      const href = attribute(node, "href");

      if (rel.includes("alternate") && type.includes("json+oembed") && href !== null) {
        oembedUrl = absolute(href, pageUrl);
      }
    }
  });

  return {
    ogTitle: truncate(openGraph.get("og:title") ?? null, 300),
    twitterTitle: truncate(twitter.get("twitter:title") ?? null, 300),
    htmlTitle: truncate(title, 300),
    ogDescription: truncate(openGraph.get("og:description") ?? null, 1_000),
    htmlDescription: truncate(description, 1_000),
    twitterDescription: truncate(twitter.get("twitter:description") ?? null, 1_000),
    siteName:
      truncate(openGraph.get("og:site_name") ?? null, 100) ??
      truncate(twitter.get("twitter:site") ?? null, 100),
    imageUrl: absolute(openGraph.get("og:image") ?? twitter.get("twitter:image") ?? null, pageUrl),
    oembedUrl,
  };
}

interface OembedData {
  readonly title: string | null;
  readonly provider: string | null;
  readonly imageUrl: string | null;
}

async function fetchOembed(
  url: string,
  fetch: SafeFetch,
  pageUrl: string,
): Promise<OembedData | null> {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    const type = response.headers.get("content-type") ?? "";

    if (!type.includes("json")) {
      return null;
    }

    const value: unknown = await response.json();

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }

    const data = value as Record<string, unknown>;
    const title = typeof data.title === "string" ? truncate(data.title, 300) : null;
    const provider =
      typeof data.provider_name === "string" ? truncate(data.provider_name, 100) : null;
    const imageUrl =
      typeof data.thumbnail_url === "string" ? absolute(data.thumbnail_url, pageUrl) : null;

    return { title, provider, imageUrl };
  } catch {
    return null;
  }
}

/**
 * Fetches and parses one URL for the unfurl cache. `safeFetch` enforces the SSRF, size, time
 * and redirect rules (ADR 0016), so a blocked address never reaches the network.
 */
export async function fetchUnfurl(
  input: string,
  options: UnfurlFetchOptions = {},
): Promise<UnfurlFetchResult> {
  const url = normaliseUnfurlUrl(input);

  if (url === null) {
    return { kind: "failed", code: "invalid_url" };
  }

  const fetch = options.fetch ?? defaultFetch();
  let response: Response;

  try {
    response = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "BulletinUnfurl/1.0",
      },
    });
  } catch (error) {
    if (error instanceof SafeFetchError) {
      return error.code === "blocked_address" || error.code === "dns_error"
        ? { kind: "blocked", error: error.code }
        : { kind: "failed", code: error.code };
    }

    return { kind: "failed", code: "network" };
  }

  if (!response.ok) {
    return { kind: "failed", code: `http_${response.status}` };
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    return { kind: "failed", code: "unsupported_content" };
  }

  let html: string;

  try {
    html = await response.text();
  } catch {
    return { kind: "failed", code: "body_too_large" };
  }

  const meta = metadata(html, url);
  const openGraphTitle = meta.ogTitle ?? meta.twitterTitle;
  const openGraphDescription =
    meta.ogDescription ?? meta.twitterDescription ?? meta.htmlDescription;
  const needsOembed = openGraphTitle === null || openGraphDescription === null;
  const oembed =
    needsOembed && meta.oembedUrl !== null ? await fetchOembed(meta.oembedUrl, fetch, url) : null;
  const title = openGraphTitle ?? oembed?.title ?? meta.htmlTitle;

  if (title === null) {
    return { kind: "failed", code: "no_preview" };
  }

  return {
    kind: "preview",
    preview: {
      kind: openGraphTitle === null && oembed?.title !== null ? "oembed" : "opengraph",
      url,
      title,
      description: openGraphDescription,
      siteName: meta.siteName ?? oembed?.provider ?? null,
      provider: oembed?.provider ?? null,
      imageUrl: meta.imageUrl ?? oembed?.imageUrl ?? null,
      imageProxy: null,
    },
  };
}

interface UnfurlRow {
  readonly url_hash: string;
  readonly url: string;
  readonly status: UnfurlStatus;
  readonly preview: unknown;
  readonly fetched_at: Date | null;
  readonly updated_at: Date;
}

function parsePreview(value: unknown): UnfurlPreview | null {
  let parsed: unknown = value;

  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const data = parsed as Record<string, unknown>;

  if (
    (data.kind !== "opengraph" && data.kind !== "oembed") ||
    typeof data.url !== "string" ||
    typeof data.title !== "string"
  ) {
    return null;
  }

  return {
    kind: data.kind,
    url: data.url,
    title: data.title,
    description: typeof data.description === "string" ? data.description : null,
    siteName: typeof data.siteName === "string" ? data.siteName : null,
    provider: typeof data.provider === "string" ? data.provider : null,
    imageUrl: typeof data.imageUrl === "string" ? data.imageUrl : null,
    imageProxy:
      typeof data.imageProxy === "string" && /^\/unfurl\/[0-9a-f]{64}$/.test(data.imageProxy)
        ? data.imageProxy
        : null,
  };
}

function toRecord(row: UnfurlRow): UnfurlRecord {
  return {
    urlHash: row.url_hash,
    url: row.url,
    status: row.status,
    preview: parsePreview(row.preview),
    fetchedAt: row.fetched_at,
    updatedAt: row.updated_at,
  };
}

export function isUnfurlFresh(record: UnfurlRecord, now: Date = new Date()): boolean {
  return (
    record.status === "ready" &&
    record.fetchedAt !== null &&
    now.getTime() - record.fetchedAt.getTime() < REFRESH_AFTER_MS
  );
}

export async function readUnfurl(sql: SQL, urlHash: string): Promise<UnfurlRecord | null> {
  const rows = (await sql`
    SELECT url_hash, url, status, preview, fetched_at, updated_at
    FROM core.unfurls
    WHERE url_hash = ${urlHash}
  `) as UnfurlRow[];

  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

export async function readUnfurlPreview(sql: SQL, urlHash: string): Promise<UnfurlPreview | null> {
  return (await readUnfurl(sql, urlHash))?.preview ?? null;
}

export interface RequestUnfurlResult {
  readonly urlHash: string;
  /** True when the caller should enqueue the worker. */
  readonly needed: boolean;
}

/**
 * Registers a pending unfurl row. A fresh ready row returns `needed: false`, so posting the
 * same link repeatedly does not refetch it.
 */
export async function requestUnfurl(
  sql: SQL,
  input: string,
  now: Date = new Date(),
): Promise<RequestUnfurlResult | null> {
  const url = normaliseUnfurlUrl(input);

  if (url === null) {
    return null;
  }

  const urlHash = hashUnfurlUrl(url);
  const staleBefore = new Date(now.getTime() - REFRESH_AFTER_MS);
  const rows = (await sql`
    INSERT INTO core.unfurls (url_hash, url, status, updated_at)
    VALUES (${urlHash}, ${url}, 'pending', ${now})
    ON CONFLICT (url_hash) DO UPDATE
      SET url = EXCLUDED.url,
        status = 'pending',
        updated_at = now()
      WHERE core.unfurls.status <> 'ready'
        OR core.unfurls.fetched_at IS NULL
        OR core.unfurls.fetched_at < ${staleBefore}
    RETURNING url_hash
  `) as Array<{ url_hash: string }>;

  return { urlHash, needed: rows.length > 0 };
}

export interface RecordUnfurlResult {
  readonly urlHash: string;
  readonly url: string;
  readonly result: UnfurlFetchResult;
  readonly now?: Date;
}

/** Stores a worker result. A failed refresh keeps the previous preview for stale serving. */
export async function recordUnfurlResult(sql: SQL, input: RecordUnfurlResult): Promise<void> {
  const now = input.now ?? new Date();
  const status: UnfurlStatus =
    input.result.kind === "preview"
      ? "ready"
      : input.result.kind === "blocked"
        ? "blocked"
        : "failed";

  if (input.result.kind === "preview") {
    await sql`
      UPDATE core.unfurls
      SET status = ${status},
        preview = ${JSON.stringify(input.result.preview)}::jsonb,
        fetched_at = ${now},
        updated_at = ${now}
      WHERE url_hash = ${input.urlHash} AND url = ${input.url}
    `;
    return;
  }

  await sql`
    UPDATE core.unfurls
    SET status = ${status},
      updated_at = ${now}
    WHERE url_hash = ${input.urlHash} AND url = ${input.url}
  `;
}

/** Pending and seven-day-old rows for the refresh sweep. */
export async function listStaleUnfurls(
  sql: SQL,
  options: { readonly now?: Date; readonly limit?: number } = {},
): Promise<readonly UnfurlRecord[]> {
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - REFRESH_AFTER_MS);
  const limit = options.limit ?? 100;
  const rows = (await sql`
    SELECT url_hash, url, status, preview, fetched_at, updated_at
    FROM core.unfurls
    WHERE status = 'pending' OR updated_at < ${staleBefore}
    ORDER BY updated_at, url_hash
    LIMIT ${limit}
  `) as UnfurlRow[];

  return rows.map(toRecord);
}
