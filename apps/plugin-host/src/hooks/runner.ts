import type { Logger } from "@bulletin/config";
import type { ViewerContext } from "@bulletin/plugin-sdk/hooks";
import { type PluginHookRegistry, pluginTag } from "./registry.ts";

/** The transport the host uses to reach one plugin sandbox (the broker channel). */
export interface HookTransport {
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
}

export interface EnrichInput {
  readonly hook: string;
  readonly route: string;
  readonly view: Readonly<Record<string, unknown>>;
  readonly viewer: ViewerContext;
  readonly deadlineMs?: number;
}

export interface Enriched {
  readonly fields: Readonly<Record<string, unknown>>;
  /** Namespaced cache tags declared by the enrichers that ran. */
  readonly tags: readonly string[];
  readonly failures: readonly string[];
}

export interface FilterInput {
  readonly hook: string;
  readonly content: string;
  readonly context: {
    readonly authorId: string;
    readonly forumId?: string;
    readonly topicId?: string;
    readonly postId?: string;
  };
  readonly viewer: ViewerContext;
  readonly budgetMs?: number;
}

export interface Filtered {
  readonly content: string;
  /** Set when a fail-closed veto rejected the write. */
  readonly veto?: { readonly reasonKey: string; readonly pluginId: string };
  readonly failures: readonly string[];
  readonly timedOut: readonly string[];
}

export interface VetoOutcome {
  readonly allow: boolean;
  readonly reasonKey?: string;
  readonly pluginId?: string;
  readonly unavailable?: boolean;
}

const DEFAULT_ENRICHER_DEADLINE_MS = 100;
const DEFAULT_WRITE_BUDGET_MS = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Dispatches view-model enrichers and write filters/vetoes to plugin sandboxes (ADR 0009).
 *
 * Every call has a deadline and a failure policy: an enricher that misses 100 ms leaves its
 * field empty; a transform that fails or misses the shared write budget is skipped. A
 * fail-closed veto that cannot answer rejects the write with a translated reason.
 */
export class PluginHookRunner {
  readonly #transport: HookTransport;
  readonly #registry: PluginHookRegistry;
  readonly #logger: Logger;

  readonly #isActive: (pluginId: string) => Promise<boolean>;

  constructor(options: {
    readonly transport: HookTransport;
    readonly registry: PluginHookRegistry;
    readonly logger: Logger;
    /** Runtime state/flag check; disabled plugins never receive a dispatch. */
    readonly isActive?: (pluginId: string) => Promise<boolean>;
    readonly onFailure?: (pluginId: string, hook: string, error: unknown) => void;
    readonly onSuccess?: (pluginId: string, hook: string) => void;
  }) {
    this.#transport = options.transport;
    this.#registry = options.registry;
    this.#logger = options.logger;
    this.#isActive = options.isActive ?? (async () => true);
    this.#onFailure = options.onFailure;
    this.#onSuccess = options.onSuccess;
  }

  readonly #onFailure: ((pluginId: string, hook: string, error: unknown) => void) | undefined;
  readonly #onSuccess: ((pluginId: string, hook: string) => void) | undefined;

  async #active(pluginId: string): Promise<boolean> {
    return this.#isActive(pluginId).catch(() => false);
  }

  async enrich(input: EnrichInput): Promise<Enriched> {
    const fields: Record<string, unknown> = {};
    const tags = new Set<string>();
    const failures: string[] = [];
    const deadline = input.deadlineMs ?? DEFAULT_ENRICHER_DEADLINE_MS;

    await Promise.all(
      this.#registry.enrichers(input.hook).map(async (entry) => {
        if (!(await this.#active(entry.pluginId))) {
          return;
        }

        try {
          const result = await this.#transport.request<{
            fields?: unknown;
            tags?: unknown;
          }>(
            "hook.enrich",
            {
              hook: input.hook,
              route: input.route,
              view: input.view,
              viewer: input.viewer,
            },
            deadline,
          );

          const returned = isRecord(result) && isRecord(result.fields) ? result.fields : {};
          const declared = new Set(entry.fields);

          for (const [name, value] of Object.entries(returned)) {
            if (declared.has(name)) {
              fields[name] = value;
            }
          }

          for (const tag of Array.isArray(result.tags) ? result.tags : []) {
            if (typeof tag === "string" && tag !== "") {
              tags.add(pluginTag(entry.pluginId, tag));
            }
          }

          for (const dep of entry.deps ?? []) {
            tags.add(pluginTag(entry.pluginId, dep));
          }
          this.#onSuccess?.(entry.pluginId, input.hook);
        } catch (error) {
          this.#onFailure?.(entry.pluginId, input.hook, error);
          failures.push(entry.pluginId);
          this.#logger.warn("plugin.enricher_failed", {
            pluginId: entry.pluginId,
            hook: input.hook,
            error,
          });
        }
      }),
    );

    return { fields, tags: [...tags].sort(), failures };
  }

  async filter(input: FilterInput): Promise<Filtered> {
    const budget = input.budgetMs ?? DEFAULT_WRITE_BUDGET_MS;
    const started = performance.now();
    const remaining = (): number => budget - (performance.now() - started);
    const filters = this.#registry.filters(input.hook);
    const failures: string[] = [];
    const timedOut: string[] = [];
    let content = input.content;

    for (const entry of filters) {
      if (!(await this.#active(entry.pluginId))) {
        continue;
      }

      const left = remaining();

      if (left <= 0) {
        timedOut.push(entry.pluginId);
        continue;
      }

      try {
        const result = await this.#transport.request<{ content?: unknown }>(
          "hook.filter",
          {
            hook: input.hook,
            content,
            context: input.context,
            viewer: input.viewer,
          },
          left,
        );

        if (isRecord(result) && typeof result.content === "string") {
          content = result.content;
        }
        this.#onSuccess?.(entry.pluginId, input.hook);
      } catch (error) {
        this.#onFailure?.(entry.pluginId, input.hook, error);
        failures.push(entry.pluginId);
        this.#logger.warn("plugin.filter_failed", {
          pluginId: entry.pluginId,
          hook: input.hook,
          error,
        });
      }
    }

    for (const entry of this.#registry.vetoes(input.hook)) {
      if (!(await this.#active(entry.pluginId))) {
        continue;
      }

      const outcome = await this.#veto(
        entry.pluginId,
        entry.failMode ?? "open",
        input,
        remaining(),
      );

      if (!outcome.allow) {
        return {
          content,
          ...(outcome.reasonKey === undefined
            ? {}
            : { veto: { reasonKey: outcome.reasonKey, pluginId: entry.pluginId } }),
          failures,
          timedOut,
        };
      }

      if (outcome.unavailable === true) {
        timedOut.push(entry.pluginId);
      }
    }

    return { content, failures, timedOut };
  }

  async #veto(
    pluginId: string,
    failMode: "open" | "closed",
    input: FilterInput,
    timeoutMs: number,
  ): Promise<VetoOutcome> {
    if (timeoutMs <= 0) {
      return this.#vetoUnavailable(pluginId, failMode, "deadline");
    }

    try {
      const result = await this.#transport.request<{ allow?: unknown; reasonKey?: unknown }>(
        "hook.veto",
        {
          hook: input.hook,
          content: input.content,
          context: input.context,
          viewer: input.viewer,
        },
        timeoutMs,
      );

      this.#onSuccess?.(pluginId, input.hook);

      if (isRecord(result) && result.allow === false) {
        return {
          allow: false,
          ...(typeof result.reasonKey === "string" ? { reasonKey: result.reasonKey } : {}),
          pluginId,
        };
      }

      return { allow: true, pluginId };
    } catch (error) {
      this.#onFailure?.(pluginId, input.hook, error);
      this.#logger.warn("plugin.veto_failed", {
        pluginId,
        hook: input.hook,
        failMode,
        error,
      });
      return this.#vetoUnavailable(pluginId, failMode, "error");
    }
  }

  #vetoUnavailable(pluginId: string, failMode: "open" | "closed", _reason: string): VetoOutcome {
    return failMode === "closed"
      ? {
          allow: false,
          reasonKey: "plugin.veto.unavailable",
          pluginId,
          unavailable: true,
        }
      : { allow: true, pluginId, unavailable: true };
  }
}
