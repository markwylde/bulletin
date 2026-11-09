import { escapeHtml, jsonResponse, renderPage } from "@bulletin/mock-ui";

const BP_PATTERN = /^(en|es|fr)\.\d{1,6}\.(light|dark|system)$/;
const SESSION_COOKIE = /^(?:__Host-)?bl_(?:session|staff)$/;

export interface CacheEntry {
  readonly key: string;
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly tags: readonly string[];
  readonly storedAt: number;
  readonly expiresAt: number;
  readonly staleUntil: number;
}

export interface CdnStats {
  readonly entries: number;
  readonly hits: number;
  readonly misses: number;
  readonly stales: number;
  readonly bypasses: number;
}

export interface CdnOptions {
  readonly origin: string;
  readonly upstreamHost?: string;
  readonly now?: () => number;
  readonly maxEntries?: number;
}

export interface CdnMock {
  handler(request: Request): Promise<Response>;
  purge(keys: readonly string[]): number;
  stats(): CdnStats;
  readonly entries: readonly CacheEntry[];
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");

  if (header === null) {
    return null;
  }

  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      return value.join("=") || null;
    }
  }

  return null;
}

function hasSessionCookie(request: Request): boolean {
  const header = request.headers.get("cookie");

  if (header === null) {
    return false;
  }

  return header
    .split(";")
    .map((part) => part.trim().split("=")[0] ?? "")
    .some((name) => SESSION_COOKIE.test(name));
}

function bpKey(request: Request): string {
  const value = cookieValue(request, "bp");
  return value !== null && BP_PATTERN.test(value) ? value : "";
}

function cacheKey(request: Request, url: URL): string {
  return `${request.method}:${url.pathname}${url.search}:bp=${bpKey(request)}`;
}

function directives(cacheControl: string | null): Map<string, string | true> {
  const result = new Map<string, string | true>();

  if (cacheControl === null) {
    return result;
  }

  for (const part of cacheControl.split(",")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    const name = rawName?.toLowerCase();

    if (name === undefined || name === "") {
      continue;
    }

    result.set(name, rawValue.join("=").replace(/^"|"$/g, "") || true);
  }

  return result;
}

function seconds(map: Map<string, string | true>, name: string): number {
  const value = map.get(name);
  return typeof value === "string" ? Number(value) : Number.NaN;
}

function cachePolicy(headers: Headers): { ttl: number; stale: number } | null {
  const map = directives(headers.get("cache-control"));

  if (map.has("no-store") || map.has("private")) {
    return null;
  }

  const ttl = Number.isFinite(seconds(map, "s-maxage"))
    ? seconds(map, "s-maxage")
    : seconds(map, "max-age");

  if (!Number.isFinite(ttl) || ttl <= 0) {
    return null;
  }

  const stale = seconds(map, "stale-while-revalidate");
  return { ttl, stale: Number.isFinite(stale) && stale > 0 ? stale : 0 };
}

function tags(headers: Headers): string[] {
  const raw = headers.get("surrogate-key");

  if (raw === null) {
    return [];
  }

  return raw
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function withCacheHeaders(
  response: Response,
  cache: "HIT" | "MISS" | "STALE" | "BYPASS",
  key: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set("x-cache", cache);
  headers.set("x-cache-key", key);
  return new Response(response.body, { status: response.status, headers });
}

function copyRequestHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return headers;
}

export function createCdn(options: CdnOptions): CdnMock {
  const now = options.now ?? (() => Date.now());
  const maxEntries = options.maxEntries ?? 1000;
  const entries = new Map<string, CacheEntry>();
  const inFlight = new Set<string>();
  let hits = 0;
  let misses = 0;
  let stales = 0;
  let bypasses = 0;

  const store = (key: string, response: Response, body: Uint8Array): void => {
    const policy = cachePolicy(response.headers);

    if (policy === null) {
      return;
    }

    const storedAt = now();
    entries.set(key, {
      key,
      status: response.status,
      headers: new Headers(response.headers),
      body,
      tags: tags(response.headers),
      storedAt,
      expiresAt: storedAt + policy.ttl * 1000,
      staleUntil: storedAt + (policy.ttl + policy.stale) * 1000,
    });

    if (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) {
        entries.delete(oldest);
      }
    }
  };

  const fetchOrigin = async (request: Request, url: URL): Promise<Response> => {
    const target = new URL(`${url.pathname}${url.search}`, options.origin).toString();
    const headers = copyRequestHeaders(request);
    headers.set("host", options.upstreamHost ?? new URL(options.origin).host);
    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: "manual",
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = await request.arrayBuffer();
    }

    return fetch(target, init);
  };

  const refresh = (entry: CacheEntry, request: Request, url: URL): void => {
    if (inFlight.has(entry.key)) {
      return;
    }

    inFlight.add(entry.key);
    void fetchOrigin(request, url)
      .then(async (response) => {
        const body = new Uint8Array(await response.arrayBuffer());
        store(entry.key, response, body);
      })
      .catch(() => undefined)
      .finally(() => inFlight.delete(entry.key));
  };

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/health" || url.pathname === "/api/stats") {
      return jsonResponse({
        status: "ok",
        ...stats(),
        origin: options.origin,
      });
    }

    if (url.pathname === "/__ui") {
      return new Response(renderCdnUi([...entries.values()], stats()), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/purge") {
      const body =
        request.method === "POST"
          ? ((await request.json().catch(() => ({}))) as { key?: string; keys?: string[] })
          : {};
      const keys = [
        ...(typeof body.key === "string" ? [body.key] : []),
        ...(Array.isArray(body.keys) ? body.keys : []),
        ...(url.searchParams.get("key") === null ? [] : [url.searchParams.get("key") ?? ""]),
      ].filter(Boolean);

      const purged = purge(keys);
      return jsonResponse({ purged, keys });
    }

    const key = cacheKey(request, url);

    if (hasSessionCookie(request) || request.method !== "GET") {
      bypasses += 1;
      return withCacheHeaders(await fetchOrigin(request, url), "BYPASS", key);
    }

    const cached = entries.get(key);

    if (cached !== undefined && now() < cached.expiresAt) {
      hits += 1;
      return withCacheHeaders(
        new Response(cached.body, { status: cached.status, headers: cached.headers }),
        "HIT",
        key,
      );
    }

    if (cached !== undefined && now() < cached.staleUntil) {
      stales += 1;
      refresh(cached, request, url);
      return withCacheHeaders(
        new Response(cached.body, { status: cached.status, headers: cached.headers }),
        "STALE",
        key,
      );
    }

    misses += 1;
    const response = await fetchOrigin(request, url);
    const body = new Uint8Array(await response.arrayBuffer());
    store(key, response, body);
    return withCacheHeaders(
      new Response(body, { status: response.status, headers: response.headers }),
      "MISS",
      key,
    );
  };

  const purge = (keys: readonly string[]): number => {
    let purged = 0;

    for (const [key, entry] of entries) {
      if (entry.tags.some((tag) => keys.includes(tag))) {
        entries.delete(key);
        purged += 1;
      }
    }

    return purged;
  };

  const stats = (): CdnStats => ({
    entries: entries.size,
    hits,
    misses,
    stales,
    bypasses,
  });

  return {
    handler,
    purge,
    stats,
    get entries() {
      return [...entries.values()];
    },
  };
}

export function renderCdnUi(entries: readonly CacheEntry[], stats: CdnStats): string {
  const rows = entries
    .map(
      (entry) => `<tr>
        <td><code>${escapeHtml(entry.key)}</code></td>
        <td>${escapeHtml(entry.tags.join(" "))}</td>
        <td>${entry.status}</td>
        <td>${escapeHtml(new Date(entry.expiresAt).toISOString())}</td>
      </tr>`,
    )
    .join("");

  return renderPage(
    "CDN mock",
    `<p class="lede">Caching reverse proxy. Purge by surrogate key with <code>POST /purge {"keys":["forum:3"]}</code>.</p>
     <p>${stats.hits} hits, ${stats.misses} misses, ${stats.stales} stale, ${stats.bypasses} bypasses.</p>
     <div class="panel"><table><thead><tr><th>Cache key</th><th>Tags</th><th>Status</th><th>Expires</th></tr></thead><tbody>${rows}</tbody></table></div>`,
  );
}
