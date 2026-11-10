import { createVersionedCache } from "@bulletin/cache";
import {
  clientFlagValues,
  evaluateFlag,
  evaluateFlags,
  renderFlagsHash,
  renderFlagValues,
} from "./evaluate.ts";
import type { FlagDefinition, FlagViewer } from "./types.ts";

/** Durable cache tag holding the flag definitions (ADR 0006). */
export const FLAG_CACHE_TAG = "flags";

/** The 1 s backstop from ADR 0006, independent of NOTIFY. */
export const FLAG_BACKSTOP_MS = 1_000;

/** Supplies the durable tag version and the definition snapshot. */
export interface FlagDefinitionSource {
  version(): Promise<string>;
  load(): Promise<readonly FlagDefinition[]>;
}

export interface FlagRuntimeOptions {
  readonly backstopMs?: number;
  readonly now?: () => number;
}

/**
 * Synchronous evaluation from an in-process snapshot. Call `ensureFresh()` once per request;
 * it checks the `flags` tag version at most once per backstop interval, and `invalidate()` on
 * a NOTIFY makes the next request reload immediately.
 */
export interface FlagRuntime {
  ensureFresh(): Promise<void>;
  invalidate(): void;
  /** Unknown keys fail closed. */
  isOn(viewer: FlagViewer, key: string): boolean;
  has(key: string): boolean;
  definitions(): readonly FlagDefinition[];
  evaluateAll(viewer: FlagViewer): Record<string, boolean>;
  renderFlags(viewer: FlagViewer): Record<string, boolean>;
  renderFlagsHash(viewer: FlagViewer): string;
  /** Only flags marked `clientVisible`; safe to embed in a page or overlay payload. */
  clientFlags(viewer: FlagViewer): Record<string, boolean>;
}

export function createFlagRuntime(
  source: FlagDefinitionSource,
  options: FlagRuntimeOptions = {},
): FlagRuntime {
  const backstopMs = options.backstopMs ?? FLAG_BACKSTOP_MS;
  const now = options.now ?? Date.now;
  const cache = createVersionedCache<string, readonly FlagDefinition[]>({
    version: () => source.version(),
    load: () => source.load(),
  });

  let definitions: readonly FlagDefinition[] = [];
  let byKey = new Map<string, FlagDefinition>();
  let loaded = false;
  let invalidated = false;
  let lastCheckedAt = 0;
  let generation = 0;
  let inflight: Promise<void> | null = null;

  function replace(value: readonly FlagDefinition[]): void {
    definitions = value;
    byKey = new Map(value.map((definition) => [definition.key, definition]));
    loaded = true;
  }

  async function reload(): Promise<void> {
    const startedAt = generation;
    const { value } = await cache.get(FLAG_CACHE_TAG);
    replace(value);
    lastCheckedAt = now();
    // An invalidation that arrived while the load was running must not be swallowed.
    invalidated = generation !== startedAt;
  }

  function stale(): boolean {
    return !loaded || invalidated || now() - lastCheckedAt >= backstopMs;
  }

  return {
    async ensureFresh() {
      if (!stale()) {
        return;
      }

      inflight ??= reload().finally(() => {
        inflight = null;
      });
      await inflight;
    },

    invalidate() {
      cache.invalidate(FLAG_CACHE_TAG);
      generation += 1;
      invalidated = true;
    },

    isOn(viewer, key) {
      const definition = byKey.get(key);
      return definition === undefined ? false : evaluateFlag(definition, viewer);
    },

    has(key) {
      return byKey.has(key);
    },

    definitions() {
      return definitions;
    },

    evaluateAll(viewer) {
      return evaluateFlags(definitions, viewer);
    },

    renderFlags(viewer) {
      return renderFlagValues(definitions, viewer);
    },

    renderFlagsHash(viewer) {
      return renderFlagsHash(renderFlagValues(definitions, viewer));
    },

    clientFlags(viewer) {
      return clientFlagValues(definitions, viewer);
    },
  };
}
