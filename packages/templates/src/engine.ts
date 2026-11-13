import { Context, Liquid, type Template, toPromise, toValue } from "liquidjs";
import { registerHookTag } from "./hook-tag.ts";
import { registerIslandTag, type ServerIslandRegistry } from "./island-tag.ts";
import { runtimeGlobals, type TemplateRuntime } from "./runtime.ts";
import { escapeOutput } from "./safe-html.ts";
import { registerTranslationTag } from "./translation-tag.ts";

/** ADR 0008 resource limits. Lowering them through the options keeps tests fast. */
export interface TemplateLimits {
  /** Total characters parsed in one `parse()` call (1 MB). */
  readonly parseLimit: number;
  /** Milliseconds for one `render()` call of a third-party template. */
  readonly renderLimit: number;
  /**
   * Milliseconds for one `render()` call of a template whose theme has `source = 'core'`.
   * The 50 ms budget contains untrusted themes; the bundled theme is our own code, so a slow
   * machine must not turn its pages into a 500 with nothing left to fall back to (ADR 0008).
   */
  readonly trustedRenderLimit: number;
  /** New objects created in one render (10 MB). */
  readonly memoryLimit: number;
  /** UTF-8 bytes in one rendered fragment (2 MB). */
  readonly outputLimit: number;
}

export const DEFAULT_TEMPLATE_LIMITS: TemplateLimits = {
  parseLimit: 1_000_000,
  renderLimit: 50,
  trustedRenderLimit: 2_000,
  memoryLimit: 10_000_000,
  outputLimit: 2 * 1024 * 1024,
};

export interface TemplateEngineOptions {
  readonly islands: ServerIslandRegistry;
  readonly limits?: Partial<TemplateLimits>;
}

/** Per-render overrides; used by tests and by routes that tighten a limit. */
export type TemplateRenderOverrides = Partial<
  Pick<TemplateLimits, "renderLimit" | "trustedRenderLimit" | "memoryLimit" | "outputLimit">
>;

/** Thrown by the counting emitter before the rendered output can exceed the byte budget. */
export class OutputLimitExceededError extends Error {
  readonly bytes: number;
  readonly limit: number;

  constructor(bytes: number, limit: number) {
    super(`template output limit exceeded: ${bytes} bytes > ${limit}`);
    this.name = "OutputLimitExceededError";
    this.bytes = bytes;
    this.limit = limit;
  }
}

function outputText(value: unknown): string {
  const resolved = toValue(value);

  if (typeof resolved === "string") {
    return resolved;
  }

  if (resolved === null || resolved === undefined) {
    return "";
  }

  if (Array.isArray(resolved)) {
    return resolved.map(outputText).join("");
  }

  return String(resolved);
}

/**
 * LiquidJS's SimpleEmitter concatenates first and lets callers check afterwards. Themes are
 * untrusted, so the budget has to apply at every write: a runaway loop of small static chunks
 * then stops before it can hold more than the limit in memory (ADR 0008).
 */
class BoundedEmitter {
  buffer = "";
  #bytes = 0;

  constructor(private readonly limit: number) {}

  write(value: unknown): void {
    const text = outputText(value);
    const bytes = this.#bytes + Buffer.byteLength(text, "utf8");

    if (bytes > this.limit) {
      throw new OutputLimitExceededError(bytes, this.limit);
    }

    this.#bytes = bytes;
    this.buffer += text;
  }
}

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
      const emitter = new BoundedEmitter(overrides.outputLimit ?? limits.outputLimit);
      const context = new Context(
        viewModel,
        liquid.options,
        {
          globals: runtimeGlobals(runtime),
          renderLimit: overrides.renderLimit ?? limits.renderLimit,
          memoryLimit: overrides.memoryLimit ?? limits.memoryLimit,
        },
        { liquid },
      );

      return toPromise(liquid.renderer.renderTemplates(parsed, context, emitter)).then(
        () => emitter.buffer,
      ) as Promise<string>;
    },
  };
}
