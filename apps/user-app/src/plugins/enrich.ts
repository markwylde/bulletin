import { tracedFetch } from "@bulletin/config/tracing";
import type { ViewerContext } from "@bulletin/plugin-sdk/hooks";

/** Core client for view-model enrichers (ADR 0009). */

export interface Enrichment {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly tags: readonly string[];
  readonly failures: readonly string[];
}

const EMPTY: Enrichment = { fields: {}, tags: [], failures: [] };
const DEFAULT_TOKEN = "bulletin-development-only-internal-token";

export interface EnrichInput {
  readonly hook: string;
  readonly route: string;
  readonly view: Readonly<Record<string, unknown>>;
  readonly viewer: ViewerContext;
  readonly url?: string;
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * Runs the enrichers for one route. A plugin-host that is slow or down returns no fields,
 * so the page still renders (the host itself enforces the 100 ms per-enricher deadline).
 */
export async function enrichView(input: EnrichInput): Promise<Enrichment> {
  const configured = input.url ?? Bun.env.PLUGIN_HOST_INTERNAL_URL;

  if (configured === undefined || configured === "") {
    // Tests and minimal deployments without a plugin-host simply render without enrichments.
    return EMPTY;
  }

  const url = configured.replace(/\/+$/, "");
  const token = input.token ?? Bun.env.PLUGIN_INTERNAL_TOKEN ?? DEFAULT_TOKEN;
  const request = input.fetch ?? tracedFetch;

  try {
    const response = await request(`${url}/internal/enrich`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        hook: input.hook,
        route: input.route,
        view: input.view,
        viewer: input.viewer,
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 250),
    });

    if (!response.ok) {
      return EMPTY;
    }

    const body = (await response.json()) as {
      fields?: unknown;
      tags?: unknown;
      failures?: unknown;
    };

    const fields =
      typeof body.fields === "object" && body.fields !== null && !Array.isArray(body.fields)
        ? (body.fields as Record<string, unknown>)
        : {};
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    const failures = Array.isArray(body.failures)
      ? body.failures.filter((id): id is string => typeof id === "string")
      : [];

    return { fields, tags, failures };
  } catch {
    return EMPTY;
  }
}
