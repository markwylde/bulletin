import { tracedFetch } from "@bulletin/config/tracing";
import type { ViewerContext } from "@bulletin/plugin-sdk/hooks";

/** Server-side client for plugin-host route and bridge calls. */

const DEFAULT_URL = "http://plugin-host:3004";
const DEFAULT_TOKEN = "bulletin-development-only-internal-token";

export interface PluginRouteResponse {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

async function call(
  path: "/internal/routes" | "/internal/bridge",
  input: {
    readonly pluginId: string;
    readonly path: string;
    readonly method: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly body?: string | null;
    readonly viewer: ViewerContext;
  },
  options: {
    readonly url?: string;
    readonly token?: string;
    readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
    readonly timeoutMs?: number;
  } = {},
): Promise<PluginRouteResponse> {
  const base = (options.url ?? Bun.env.PLUGIN_HOST_INTERNAL_URL ?? DEFAULT_URL).replace(/\/+$/, "");
  const token = options.token ?? Bun.env.PLUGIN_INTERNAL_TOKEN ?? DEFAULT_TOKEN;
  const request = options.fetch ?? tracedFetch;

  try {
    const response = await request(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(options.timeoutMs ?? 1_500),
    });

    if (!response.ok) {
      return { status: 503, body: "", headers: {} };
    }

    const value = (await response.json()) as {
      status?: unknown;
      body?: unknown;
      headers?: unknown;
    };

    return {
      status: typeof value.status === "number" ? value.status : 200,
      body: typeof value.body === "string" ? value.body : "",
      headers:
        typeof value.headers === "object" && value.headers !== null && !Array.isArray(value.headers)
          ? (value.headers as Record<string, string>)
          : {},
    };
  } catch {
    return { status: 503, body: "", headers: {} };
  }
}

export function requestPluginRoute(
  input: Parameters<typeof call>[1],
  options?: Parameters<typeof call>[2],
): Promise<PluginRouteResponse> {
  return call("/internal/routes", input, options);
}

export function requestPluginBridge(
  input: Parameters<typeof call>[1],
  options?: Parameters<typeof call>[2],
): Promise<PluginRouteResponse> {
  return call("/internal/bridge", input, options);
}
