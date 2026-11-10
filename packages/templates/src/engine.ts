import type { Translator } from "@bulletin/i18n";
import { Liquid } from "liquidjs";
import { type HookRenderError, type HookTagOptions, registerHookTag } from "./hook-tag.ts";
import { type IslandRenderError, type IslandTagOptions, registerIslandTag } from "./island-tag.ts";
import { registerTranslationTag } from "./translation-tag.ts";

/** ADR 0008 resource limits, measured like the engine option they map to. */
export const TEMPLATE_LIMITS = {
  /** Total characters parsed in one `parse()` call (1 MB). */
  parseLimit: 1_000_000,
  /** Milliseconds for one `render()` call. */
  renderLimit: 50,
  /** New objects created in one render (10 MB). */
  memoryLimit: 10_000_000,
} as const;

export interface TemplateEngineOptions {
  readonly translate: Translator;
  readonly islands: IslandTagOptions["islands"];
  readonly hooks: HookTagOptions["fragments"];
  readonly onIslandError?: (error: IslandRenderError) => void;
  readonly onHookError?: (error: HookRenderError) => void;
}

export interface TemplateEngine {
  /** Parses and renders one template body against the view model. */
  render(template: string, viewModel: Readonly<Record<string, unknown>>): Promise<string>;
  /** The underlying engine, for callers that want to parse once and render repeatedly. */
  readonly liquid: Liquid;
}

/**
 * Builds the LiquidJS engine themes run on (ADR 0008): strict filters and variables,
 * prototype access off, and autoescaping on for every `{{ }}` output. Raw HTML only enters a
 * page through `SafeHtml` view-model fields, islands and hook fragments.
 */
export function createTemplateEngine(options: TemplateEngineOptions): TemplateEngine {
  const liquid = new Liquid({
    strictFilters: true,
    strictVariables: true,
    ownPropertyOnly: true,
    outputEscape: "escape",
    parseLimit: TEMPLATE_LIMITS.parseLimit,
    renderLimit: TEMPLATE_LIMITS.renderLimit,
    memoryLimit: TEMPLATE_LIMITS.memoryLimit,
  });

  registerTranslationTag(liquid, { translate: options.translate });
  registerIslandTag(liquid, {
    islands: options.islands,
    ...(options.onIslandError === undefined ? {} : { onError: options.onIslandError }),
  });
  registerHookTag(liquid, {
    fragments: options.hooks,
    ...(options.onHookError === undefined ? {} : { onError: options.onHookError }),
  });

  return {
    liquid,
    render(template, viewModel) {
      return liquid.parseAndRender(template, viewModel) as Promise<string>;
    },
  };
}
