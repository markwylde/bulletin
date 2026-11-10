import type { CompiledTheme, TemplateViolation } from "./compile.ts";
import type { TemplateEngine } from "./engine.ts";
import { type RenderedTemplate, renderThemeTemplate } from "./render.ts";
import type { TemplateRuntime } from "./runtime.ts";
import { safeHtml } from "./safe-html.ts";

/** One template region (header, footer, breadcrumbs, empty, error) and its view model. */
export interface ThemeRegion {
  /** The theme template to render. */
  readonly name: string;
  /** The page variable the region is exposed as; defaults to the template name. */
  readonly key?: string;
  readonly viewModel: object;
}

export interface RenderThemePageInput {
  readonly engine: TemplateEngine;
  readonly compiled: CompiledTheme;
  /** The page template, e.g. `demo` or `account`. */
  readonly name: string;
  readonly viewModel: object;
  readonly runtime: TemplateRuntime;
  /** Regions rendered first and exposed to the page as `{{ regionName }}`. */
  readonly regions?: readonly ThemeRegion[];
}

export interface RenderedThemePage {
  readonly html: string;
  /** The page template's own violations plus every region's. */
  readonly violations: readonly TemplateViolation[];
  /** The regions that rendered, for callers that need the header's report hooks. */
  readonly regions: Readonly<Record<string, RenderedTemplate>>;
}

/**
 * Composes one page from the theme: each region renders with its own view model (with the
 * same parent fallback and limits as the page) and the page receives the results as SafeHtml
 * under the region's name. This is how a theme gets its header, footer, breadcrumbs, empty and
 * error states without template includes (ADR 0008).
 */
export async function renderThemePage(input: RenderThemePageInput): Promise<RenderedThemePage> {
  const rendered: Record<string, RenderedTemplate> = {};
  const regionViewModel: Record<string, ReturnType<typeof safeHtml>> = {};

  for (const region of input.regions ?? []) {
    const result = await renderThemeTemplate({
      engine: input.engine,
      compiled: input.compiled,
      name: region.name,
      viewModel: region.viewModel,
      runtime: input.runtime,
    });

    rendered[region.name] = result;
    regionViewModel[region.key ?? region.name] = safeHtml(result.html);
  }
  const page = await renderThemeTemplate({
    engine: input.engine,
    compiled: input.compiled,
    name: input.name,
    viewModel: { ...input.viewModel, ...regionViewModel },
    runtime: input.runtime,
  });

  return {
    html: page.html,
    violations: [
      ...Object.values(rendered).flatMap((template) => template.violations),
      ...page.violations,
    ],
    regions: rendered,
  };
}
