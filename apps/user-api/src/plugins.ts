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
  filter(input: PluginWriteInput): Promise<PluginWriteResult>;
}

export interface PluginWriteClientOptions {
  readonly url?: string;
  readonly token?: string;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

const DEFAULT_URL = "http://plugin-host:3004";
const DEFAULT_TOKEN = "bulletin-development-only-internal-token";

export function createPluginWriteClient(options: PluginWriteClientOptions = {}): PluginWriteClient {
  const url = (options.url ?? Bun.env.PLUGIN_HOST_INTERNAL_URL ?? DEFAULT_URL).replace(/\/+$/, "");
  const token = options.token ?? Bun.env.PLUGIN_INTERNAL_TOKEN ?? DEFAULT_TOKEN;
  const request = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 1_000;

  return {
    async filter(input) {
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
          return { content: input.content };
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
        return { content: input.content };
      }
    },
  };
}

export const pluginWriteClient = createPluginWriteClient();
