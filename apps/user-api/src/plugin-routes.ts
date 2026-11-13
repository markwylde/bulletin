import type { ViewerContext } from "@bulletin/plugin-sdk/hooks";

/** Forwards plugin API routes and iframe bridge calls to plugin-host (ADR 0009). */

const DEFAULT_URL = "http://plugin-host:3004";
const DEFAULT_TOKEN = "bulletin-development-only-internal-token";

export interface PluginCallOptions {
  readonly url?: string;
  readonly token?: string;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

export async function pluginBridgeResponse(
  pluginId: string,
  request: Request,
  viewer: ViewerContext,
  options: PluginCallOptions = {},
): Promise<Response> {
  return forward("/internal/bridge", pluginId, request, viewer, options);
}

export async function pluginApiResponse(
  pluginId: string,
  path: string,
  request: Request,
  viewer: ViewerContext,
  options: PluginCallOptions = {},
): Promise<Response> {
  return forward("/internal/routes", pluginId, request, viewer, { ...options, path });
}

async function forward(
  endpoint: "/internal/bridge" | "/internal/routes",
  pluginId: string,
  request: Request,
  viewer: ViewerContext,
  options: PluginCallOptions & { readonly path?: string } = {},
): Promise<Response> {
  const base = (options.url ?? Bun.env.PLUGIN_HOST_INTERNAL_URL ?? DEFAULT_URL).replace(/\/+$/, "");
  const token = options.token ?? Bun.env.PLUGIN_INTERNAL_TOKEN ?? DEFAULT_TOKEN;
  const fetcher = options.fetch ?? ((target, init) => globalThis.fetch(target, init));
  const url = new URL(request.url);
  const requestBody =
    request.method === "GET" || request.method === "HEAD" ? null : await request.text();
  const path = options.path ?? url.searchParams.get("path") ?? "";
  // Only the bridge may choose a method; the outer POST already passed CSRF/Origin checks.
  // API routes keep the method the browser actually sent, so a GET cannot become a mutation.
  const method =
    endpoint === "/internal/bridge" ? (url.searchParams.get("method") ?? "GET") : request.method;
  const query = Object.fromEntries(url.searchParams.entries());

  try {
    const response = await fetcher(`${base}${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        pluginId,
        path,
        method,
        query,
        body: requestBody,
        viewer,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
    });

    if (!response.ok) {
      return Response.json({ code: "plugin_unavailable" }, { status: 503 });
    }

    const value = (await response.json()) as {
      status?: unknown;
      body?: unknown;
      headers?: unknown;
    };
    const status = typeof value.status === "number" ? value.status : 200;
    const upstream =
      typeof value.headers === "object" && value.headers !== null && !Array.isArray(value.headers)
        ? (value.headers as Record<string, unknown>)
        : {};
    const upstreamType =
      typeof upstream["content-type"] === "string" ? upstream["content-type"] : "";
    const responseBody = typeof value.body === "string" ? value.body : "";
    const headers = new Headers({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    });

    // Never execute plugin output on the forum origin, and never let it set cookies or cache.
    headers.set(
      "content-type",
      /^application\/json\b/i.test(upstreamType)
        ? "application/json; charset=utf-8"
        : "text/plain; charset=utf-8",
    );

    if (typeof upstream["content-language"] === "string") {
      headers.set("content-language", upstream["content-language"]);
    }

    return new Response(responseBody.slice(0, 512 * 1024), { status, headers });
  } catch {
    return Response.json({ code: "plugin_unavailable" }, { status: 503 });
  }
}
