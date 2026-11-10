import type { EmbedMatch, UnfurlPreview } from "./types.ts";

export type { UnfurlPreview } from "./types.ts";

export interface UnfurlResolver {
  load(urlHash: string): Promise<UnfurlPreview | null>;
}

const MAX_URL_LENGTH = 2_048;

/** Canonical form used for the cache key: absolute http(s), no fragment or credentials. */
export function normaliseUnfurlUrl(input: string): string | null {
  if (input.length > MAX_URL_LENGTH) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }

  url.hash = "";
  return url.toString();
}

export function hashUnfurlUrl(normalisedUrl: string): string {
  return new Bun.CryptoHasher("sha256").update(normalisedUrl).digest("hex");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attributes(source: string): Map<string, string> {
  const found = new Map<string, string>();

  for (const match of source.matchAll(/\b(data-url|data-url-hash)="([^"]*)"/gi)) {
    const name = match[1];
    const value = match[2];

    if (name !== undefined && value !== undefined) {
      found.set(name.toLowerCase(), decodeAttribute(value));
    }
  }

  return found;
}

function link(url: string, body: string, className: string): string {
  return `<a class="${className}" href="${escapeHtml(url)}" rel="nofollow ugc noopener">${body}</a>`;
}

/** The preview card is text-only until `attachments-avatars` proxies images (ADR 0019). */
export function renderUnfurlCard(preview: UnfurlPreview): string {
  const url = normaliseUnfurlUrl(preview.url);

  if (url === null) {
    return escapeHtml(preview.title);
  }

  const parts = [`<span class="unfurl-title">${escapeHtml(preview.title)}</span>`];

  if (preview.description !== null && preview.description !== "") {
    parts.push(`<span class="unfurl-description">${escapeHtml(preview.description)}</span>`);
  }

  if (preview.siteName !== null && preview.siteName !== "") {
    parts.push(`<span class="unfurl-site">${escapeHtml(preview.siteName)}</span>`);
  }

  return link(url, parts.join(""), "unfurl-card");
}

/**
 * Resolves stored `<bl-unfurl>` placeholders from the worker cache. A link without a fetched
 * preview stays a plain link, so pages never wait for an unfurl (ADR 0007).
 */
export async function resolveUnfurlPlaceholders(
  html: string,
  resolver: UnfurlResolver,
): Promise<string> {
  const pattern = /<bl-unfurl\b([^>]*)>([\s\S]*?)<\/bl-unfurl>/gi;
  const found = [...html.matchAll(pattern)];

  if (found.length === 0) {
    return html;
  }

  const replacements = await Promise.all(
    found.map(async (match) => {
      const map = attributes(match[1] ?? "");
      const url = map.get("data-url");
      const hash = map.get("data-url-hash");

      if (url === undefined) {
        return "";
      }

      const safeUrl = normaliseUnfurlUrl(url);

      if (safeUrl === null) {
        return "";
      }

      const preview = hash === undefined ? null : await resolver.load(hash);
      return preview === null
        ? link(safeUrl, escapeHtml(safeUrl), "unfurl-link")
        : renderUnfurlCard(preview);
    }),
  );

  let index = 0;
  return html.replace(pattern, () => replacements[index++] ?? "");
}

/** Builds the placeholder node value shared by the write pipeline and its tests. */
export interface UnfurlPlaceholder {
  readonly url: string;
  readonly urlHash: string;
}

export function unfurlPlaceholder(url: string): UnfurlPlaceholder | null {
  const normalised = normaliseUnfurlUrl(url);

  return normalised === null ? null : { url: normalised, urlHash: hashUnfurlUrl(normalised) };
}

/** Only allow an embed match to become a placeholder; kept here for the link extension. */
export type StandaloneEmbed = EmbedMatch;
