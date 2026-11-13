import type { Logger } from "@bulletin/config";

/**
 * Core client for the plugin-host write hooks (ADR 0009). The plugin-host owns the 300 ms
 * budget, fail-open/closed veto policy and translation keys; user-api only applies the
 * returned transform or rejects with the key it was given.
 */

export interface PluginWriteInput {
  readonly hook: string;
  readonly content: string;
  readonly context: {
    readonly authorId: string;
    readonly forumId?: string;
    readonly topicId?: string;
    readonly postId?: string;
  };
  readonly viewer: { readonly memberId: string | null };
}

export interface PluginWriteResult {
  readonly content: string;
  readonly veto?: { readonly reasonKey: string; readonly pluginId: string };
}

export interface PluginWriteClient {
  filter(
    input: PluginWriteInput,
    options?: { readonly failClosed?: boolean },
  ): Promise<PluginWriteResult>;
  /** HTML from every plugin content extension, still to be core-sanitised at render time. */
  extend(content: string, context?: { readonly forumId?: string }): Promise<readonly string[]>;
}

export interface PluginWriteClientOptions {
  readonly url?: string;
  readonly token?: string;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
  /** Policy when the host cannot answer; fail-closed preserves the admin's veto choice. */
  readonly vetoFailMode?: "open" | "closed";
}

const DEFAULT_TOKEN = "bulletin-development-only-internal-token";

export function createPluginWriteClient(options: PluginWriteClientOptions = {}): PluginWriteClient {
  const configured = options.url ?? Bun.env.PLUGIN_HOST_INTERNAL_URL;

  if (configured === undefined || configured === "") {
    return {
      async filter(input) {
        return { content: input.content };
      },
      async extend() {
        return [];
      },
    };
  }

  const url = configured.replace(/\/+$/, "");
  const token = options.token ?? Bun.env.PLUGIN_INTERNAL_TOKEN ?? DEFAULT_TOKEN;
  const request = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 1_000;
  const defaultFailClosed =
    options.vetoFailMode === "closed" || Bun.env.PLUGIN_VETO_FAIL_MODE === "closed";

  const unavailable = (content: string, failClosed: boolean): PluginWriteResult =>
    failClosed
      ? {
          content,
          veto: { reasonKey: "plugin.veto.unavailable", pluginId: "plugin-host" },
        }
      : { content };

  return {
    async filter(input, callOptions) {
      try {
        const response = await request(`${url}/internal/filter`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          options.logger?.warn("plugin.write_hook_failed", { status: response.status });
          return unavailable(input.content, callOptions?.failClosed ?? defaultFailClosed);
        }

        const body = (await response.json()) as {
          content?: unknown;
          veto?: { reasonKey?: unknown; pluginId?: unknown };
        };

        return {
          content: typeof body.content === "string" ? body.content : input.content,
          ...(typeof body.veto?.reasonKey === "string" && typeof body.veto.pluginId === "string"
            ? { veto: { reasonKey: body.veto.reasonKey, pluginId: body.veto.pluginId } }
            : {}),
        };
      } catch (error) {
        // A plugin-host that is down must not take posting down; the host applies fail-open
        // itself, and this is the outer safety net.
        options.logger?.warn("plugin.write_hook_unreachable", { error });
        return unavailable(input.content, callOptions?.failClosed ?? defaultFailClosed);
      }
    },

    async extend(content, context) {
      try {
        const response = await request(`${url}/internal/content-extend`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            syntax: "*",
            source: content,
            viewer: { memberId: null },
            context: context ?? {},
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          return [];
        }

        const body = (await response.json()) as { html?: unknown };
        return typeof body.html === "string" && body.html !== "" ? [body.html] : [];
      } catch {
        return [];
      }
    },
  };
}

export const pluginWriteClient = createPluginWriteClient();

/** Installed, active plugin vetoes configured fail-closed for a hook. */
export async function hasFailClosedVeto(
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>,
  hook: string,
): Promise<boolean> {
  const rows = (await sql`
    SELECT 1
    FROM core.plugin_registry r
    JOIN core.plugins p ON p.plugin_id = r.plugin_id
    JOIN core.feature_flags f ON f.key = 'plugins'
    WHERE r.kind = 'veto' AND r.key = ${hook}
      AND r.definition->>'failMode' = 'closed'
      AND p.enabled AND p.state = 'active' AND f.default_value
    LIMIT 1
  `) as unknown[];

  return rows.length > 0;
}
