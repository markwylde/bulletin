import { createFragmentCache, type FragmentCache, fragmentKey } from "@bulletin/cache";
import type { Locale, Translator } from "@bulletin/i18n";
import {
  createTemplateEngine,
  loadHookFragments,
  loadStoredTheme,
  SPIKE_PLUGIN_GENERATIONS,
  SPIKE_ROUTE,
  SPIKE_TEMPLATE_NAME,
  SPIKE_THEMES,
  type SpikeThemeName,
} from "@bulletin/templates";
import { SERVER_ISLANDS } from "@bulletin/ui/islands/server";
import type { SQL } from "bun";

export interface SpikeOptions {
  readonly theme: SpikeThemeName;
  readonly plugins: number;
  /** Measurement-only variant dimension: a fresh value forces a cold entry (task 1.2). */
  readonly bust: number;
}

export const SPIKE_DEFAULT_OPTIONS: SpikeOptions = { theme: "default", plugins: 1, bust: 0 };

const MAX_BUST = 1_000_000;

function isTheme(value: string): value is SpikeThemeName {
  return (SPIKE_THEMES as readonly string[]).includes(value);
}

function isGeneration(value: number): boolean {
  return (SPIKE_PLUGIN_GENERATIONS as readonly number[]).includes(value);
}

/** Parses the prototype's query parameters; unknown values are a 404, never a fallback. */
export function parseSpikeOptions(params: URLSearchParams): SpikeOptions | null {
  const theme = params.get("theme") ?? SPIKE_DEFAULT_OPTIONS.theme;

  if (!isTheme(theme)) {
    return null;
  }

  const plugins = Number(params.get("plugins") ?? SPIKE_DEFAULT_OPTIONS.plugins);

  if (!isGeneration(plugins)) {
    return null;
  }

  const bustParam = params.get("bust");
  const bust = bustParam === null ? SPIKE_DEFAULT_OPTIONS.bust : Number(bustParam);

  if (!Number.isSafeInteger(bust) || bust < 0 || bust > MAX_BUST) {
    return null;
  }

  return { theme, plugins, bust };
}

/**
 * The prototype route exists only in development. Task 4.2 owns the production guard and its
 * 404 test for the real `/_demo/<id>` route.
 */
export function spikeEnabled(nodeEnv: string | undefined, dev: boolean): boolean {
  return dev && nodeEnv !== "production";
}

export interface SpikeRenderInput extends SpikeOptions {
  readonly sql: SQL;
  readonly locale: Locale;
  readonly translate: Translator;
}

export type SpikeRenderOutcome =
  | {
      readonly status: "ok";
      readonly html: string;
      readonly cache: "HIT" | "MISS";
      readonly variant: string;
      readonly errors: readonly string[];
    }
  | { readonly status: "not_found" };

const fragments = createFragmentCache();

/**
 * Renders the spike page body from the database-stored theme template (task 1.1) and caches it
 * per variant (task 1.2). A theme switch or a plugin-generation bump changes the cache key, so
 * neither can serve the other's HTML.
 */
export async function renderSpikePage(
  input: SpikeRenderInput,
  cache: FragmentCache = fragments,
): Promise<SpikeRenderOutcome> {
  const errors: string[] = [];
  const reportError = (message: string): void => {
    errors.push(message);
    console.warn(`[spike-rendering] ${message}`);
  };

  const storedTheme = await loadStoredTheme(input.sql, input.theme);

  if (storedTheme === null) {
    return { status: "not_found" };
  }

  const variant = fragmentKey({
    route: SPIKE_ROUTE,
    theme: input.theme,
    themeVersion: storedTheme.version,
    plugins: input.plugins,
    locale: input.locale,
    bust: input.bust,
  });

  const template = storedTheme.templates.get(SPIKE_TEMPLATE_NAME);

  if (template === undefined) {
    return { status: "not_found" };
  }

  const islandLabel = input.translate("spike.rendering.counter");
  const viewModel = {
    theme: input.theme,
    version: storedTheme.version,
    generation: input.plugins,
    // The theme escapes this; the page must show it as text, never execute it.
    escapedSample: '<script>alert("spike")</script>',
    island: { label: islandLabel, start: 0 },
  };

  const rendered = await cache.getOrRender(variant, async () => {
    const engine = createTemplateEngine({
      translate: input.translate,
      islands: SERVER_ISLANDS,
      hooks: await loadHookFragments(input.sql, input.plugins),
      onIslandError: (error) => reportError(`${error.reason}: ${error.message}`),
      onHookError: (error) => reportError(`${error.reason}: ${error.message}`),
    });

    return engine.render(template, viewModel);
  });

  return {
    status: "ok",
    html: rendered.html,
    cache: rendered.status === "hit" ? "HIT" : "MISS",
    variant,
    errors,
  };
}
