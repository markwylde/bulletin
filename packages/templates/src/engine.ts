import { Liquid, type Template } from "liquidjs";
import { registerHookTag } from "./hook-tag.ts";
import { type IslandRegistry, registerIslandTag } from "./island-tag.ts";
import { runtimeGlobals, type TemplateRuntime } from "./runtime.ts";
import { escapeOutput } from "./safe-html.ts";
import { registerTranslationTag } from "./translation-tag.ts";

/** ADR 0008 resource limits. Lowering them through the options keeps tests fast. */
export interface TemplateLimits {
  /** Total characters parsed in one `parse()` call (1 MB). */
  readonly parseLimit: number;
  /** Milliseconds for one `render()` call. */
  readonly renderLimit: number;
  /** New objects created in one render (10 MB). */
  readonly memoryLimit: number;
  /** UTF-8 bytes in one rendered fragment (2 MB). */
  readonly outputLimit: number;
}

export const DEFAULT_TEMPLATE_LIMITS: TemplateLimits = {
  parseLimit: 1_000_000,
  renderLimit: 50,
  memoryLimit: 10_000_000,
  outputLimit: 2 * 1024 * 1024,
};

export interface TemplateEngineOptions {
  readonly islands: IslandRegistry;
  readonly limits?: Partial<TemplateLimits>;
}

/** Per-render overrides; used by tests and by routes that tighten a limit. */
export type TemplateRenderOverrides = Partial<Pick<TemplateLimits, "renderLimit" | "memoryLimit">>;

export interface TemplateEngine {
  /** The underlying engine, for callers that need its options or tag registry. */
  readonly liquid: Liquid;
  readonly limits: TemplateLimits;
  /** Parses one template body; throws on syntax errors and on the parse limit. */
  compile(source: string): Template[];
  /** Renders compiled templates against a view model (never escapes SafeHtml twice). */
  render(
    parsed: Template[],
    viewModel: object,
    runtime: TemplateRuntime,
    overrides?: TemplateRenderOverrides,
  ): Promise<string>;
}

/**
 * Builds the LiquidJS engine every theme runs on (ADR 0008): strict filters and variables,
 * prototype access off, limits on, autoescaping for every `{{ }}` output, and no way for a
 * template to mark arbitrary text safe.
 */
export function createTemplateEngine(options: TemplateEngineOptions): TemplateEngine {
  const limits: TemplateLimits = { ...DEFAULT_TEMPLATE_LIMITS, ...options.limits };
  const liquid = new Liquid({
    strictFilters: true,
    strictVariables: true,
    ownPropertyOnly: true,
    outputEscape: escapeOutput,
    parseLimit: limits.parseLimit,
    renderLimit: limits.renderLimit,
    memoryLimit: limits.memoryLimit,
  });

  // LiquidJS ships a `raw` filter that skips output escaping. ADR 0008 allows raw HTML only
  // through SafeHtml fields, islands and hook fragments, so the filter must not exist.
  liquid.unregisterFilter("raw");

  // `include`, `render` and `layout` read templates from the filesystem. Themes are untrusted
  // and are composed from named DB templates by the route, so these file-backed tags are
  // removed: ADR 0008's include-depth limit is enforced at zero rather than trusting a root.
  for (const tag of ["include", "render", "layout"]) {
    delete liquid.tags[tag];
  }

  registerTranslationTag(liquid);
  registerIslandTag(liquid, { islands: options.islands });
  registerHookTag(liquid);

  return {
    liquid,
    limits,
    compile(source) {
      return liquid.parse(source);
    },
    render(parsed, viewModel, runtime, overrides = {}) {
      return liquid.render(parsed, viewModel, {
        globals: runtimeGlobals(runtime),
        renderLimit: overrides.renderLimit ?? limits.renderLimit,
        memoryLimit: overrides.memoryLimit ?? limits.memoryLimit,
      }) as Promise<string>;
    },
  };
}
