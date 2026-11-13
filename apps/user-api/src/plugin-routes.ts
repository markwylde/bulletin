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
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.text();
  const path = options.path ?? url.searchParams.get("path") ?? "";
  const method = url.searchParams.get("method") ?? request.method;
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
        body,
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
    const headers = new Headers({ "cache-control": "no-store" });

    if (
      typeof value.headers === "object" &&
      value.headers !== null &&
      !Array.isArray(value.headers)
    ) {
      for (const [name, header] of Object.entries(value.headers)) {
        if (typeof header === "string" && !/^content-length$/i.test(name)) {
          headers.set(name, header);
        }
      }
    }

    return new Response(typeof value.body === "string" ? value.body : "", { status, headers });
  } catch {
    return Response.json({ code: "plugin_unavailable" }, { status: 503 });
  }
}
