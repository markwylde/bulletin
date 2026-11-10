import { createFragmentCache, type FragmentCache, fragmentKey } from "@bulletin/cache";
import type { Locale, Translator } from "@bulletin/i18n";
import {
  contractTags,
  createCompileCache,
  createTemplateEngine,
  escapeHtml,
  loadHookFragments,
  loadTheme,
  missingRenderedIslands,
  renderThemeTemplate,
  SPIKE_FOOTER_TEMPLATE,
  SPIKE_PAGE_TEMPLATE,
  SPIKE_PLUGIN_GENERATIONS,
  SPIKE_THEMES,
  type SpikeThemeName,
  safeHtml,
  type TemplateRuntime,
  type TemplateViolation,
  type ViewModelContract,
} from "@bulletin/templates";
import { SERVER_ISLANDS } from "@bulletin/ui/islands/server";
import type { SQL } from "bun";
import type { SpikeViewModel } from "../contracts.ts";

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
  /** The route's view-model contract (task 2.4): its route, tags and CDN eligibility. */
  readonly contract: ViewModelContract<SpikeViewModel>;
}

export type SpikeRenderOutcome =
  | {
      readonly status: "ok";
      readonly html: string;
      readonly cache: "HIT" | "MISS";
      readonly variant: string;
      /** Cache tags declared by the contract for this view model. */
      readonly tags: readonly string[];
      readonly errors: readonly string[];
    }
  | { readonly status: "not_found" };

/** One engine and compile cache per process, shared by every locale (ADR 0008). */
const engine = createTemplateEngine({ islands: SERVER_ISLANDS });
const compiledThemes = createCompileCache(engine);
const fragments = createFragmentCache();

/**
 * Renders the spike page from the database-stored theme (tasks 1.1, 2.1) and caches it per
 * variant (task 1.2). The footer comes from the theme chain, so a child theme that overrides
 * only the page still shows the parent's footer.
 */
export async function renderSpikePage(
  input: SpikeRenderInput,
  cache: FragmentCache = fragments,
): Promise<SpikeRenderOutcome> {
  const theme = await loadTheme(input.sql, input.theme);

  if (theme === null) {
    return { status: "not_found" };
  }

  const tags = contractTags(input.contract, { theme: input.theme, plugins: input.plugins });
  const variant = fragmentKey({
    route: input.contract.route,
    theme: theme.theme.name,
    themeVersion: theme.theme.version,
    plugins: input.plugins,
    locale: input.locale,
    bust: input.bust,
  });
  const errors: string[] = [];
  const report = (message: string): void => {
    errors.push(message);
    console.warn(`[spike-rendering] ${message}`);
  };

  const rendered = await cache.getOrRender(variant, async () => {
    const runtime: TemplateRuntime = {
      translate: input.translate,
      hooks: await loadHookFragments(input.sql, input.plugins),
      report,
    };
    const compiled = compiledThemes.compile(theme, input.plugins);
    const islandLabel = input.translate("spike.rendering.counter");
    const viewModel = {
      theme: theme.theme.name,
      version: theme.theme.version,
      generation: input.plugins,
      // The theme escapes this; the page must show it as text, never execute it.
      escapedSample: '<script>alert("spike")</script>',
      // The only way to raw markup: a SafeHtml field, built from escaped content here.
      trustedHtml: safeHtml(
        `<strong data-spike-safe>${escapeHtml(input.translate("spike.rendering.trusted"))}</strong>`,
      ),
      island: { label: islandLabel, start: 0 },
    };
    const reportViolations = (violations: readonly TemplateViolation[]): void => {
      for (const violation of violations) {
        report(`${violation.kind}: ${violation.theme}/${violation.template}: ${violation.message}`);
      }
    };

    const footer = await renderThemeTemplate({
      engine,
      compiled,
      name: SPIKE_FOOTER_TEMPLATE,
      viewModel,
      runtime,
    });
    reportViolations(footer.violations);

    const page = await renderThemeTemplate({
      engine,
      compiled,
      name: SPIKE_PAGE_TEMPLATE,
      viewModel: { ...viewModel, footer: safeHtml(footer.html) },
      runtime,
    });
    reportViolations(page.violations);

    // The required-islands check per route (ADR 0008, task 3.2). Activation refuses such a
    // theme; at render time we report it and keep serving the page.
    for (const island of missingRenderedIslands(page.html, input.contract.requiredIslands)) {
      report(`required island "${island}" is missing from route "${input.contract.route}"`);
    }

    return page.html;
  });

  return {
    status: "ok",
    html: rendered.html,
    cache: rendered.status === "hit" ? "HIT" : "MISS",
    variant,
    tags,
    errors,
  };
}
