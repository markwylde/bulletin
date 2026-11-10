import type { CompiledTheme, CompiledThemeTemplate, TemplateViolation } from "./compile.ts";
import { describeError } from "./compile.ts";
import type { TemplateEngine, TemplateLimits } from "./engine.ts";
import type { TemplateRuntime } from "./runtime.ts";

export interface RenderTemplateInput {
  readonly engine: TemplateEngine;
  readonly compiled: CompiledTheme;
  /** Template name to render, e.g. `page` or `footer`. */
  readonly name: string;
  readonly viewModel: object;
  readonly runtime: TemplateRuntime;
  /** Tightens the engine limits for this render (tests, previews). */
  readonly limits?: Partial<Pick<TemplateLimits, "renderLimit" | "memoryLimit" | "outputLimit">>;
}

export interface RenderedTemplate {
  readonly html: string;
  /** The override that produced the HTML; not necessarily the theme's own. */
  readonly template: CompiledThemeTemplate;
  readonly violations: readonly TemplateViolation[];
}

export class TemplateRenderError extends Error {
  readonly template: string;
  readonly violations: readonly TemplateViolation[];

  constructor(template: string, violations: readonly TemplateViolation[]) {
    const detail =
      violations.length === 0
        ? `no theme provides template "${template}"`
        : violations[violations.length - 1]?.message;
    super(`Template "${template}" could not be rendered: ${detail}`);
    this.name = "TemplateRenderError";
    this.template = template;
    this.violations = violations;
  }
}

class OutputLimitExceededError extends Error {
  constructor(bytes: number, limit: number) {
    super(`template output limit exceeded: ${bytes} bytes > ${limit}`);
    this.name = "OutputLimitExceededError";
  }
}

/**
 * True for LiquidJS resource-limit failures (render, memory and parse limits throw an
 * `AssertionError` whose message ends in "limit exceeded", wrapped by the engine). ADR 0008:
 * a template that exceeds a limit falls back to the parent theme's version.
 */
export function isLimitViolation(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();

    if (!(current instanceof Error) || seen.has(current)) {
      continue;
    }

    seen.add(current);

    if (/limit exceeded/i.test(current.message)) {
      return true;
    }

    const original = (current as { originalError?: unknown }).originalError;

    if (original !== undefined) {
      queue.push(original);
    }

    const nested = (current as { errors?: unknown }).errors;

    if (Array.isArray(nested)) {
      queue.push(...nested);
    }
  }

  return false;
}

/**
 * Renders a template name from a compiled theme, walking the parent chain when a limit is
 * exceeded (or a child override failed to compile) and reporting each fallback (ADR 0008).
 * Template bugs that are not limit violations propagate: they must be fixed, not hidden.
 */
export async function renderThemeTemplate(input: RenderTemplateInput): Promise<RenderedTemplate> {
  const violations: TemplateViolation[] = input.compiled.violations.filter(
    (violation) => violation.template === input.name,
  );
  const candidates = input.compiled.templates(input.name);

  if (candidates.length === 0) {
    throw new TemplateRenderError(input.name, violations);
  }

  const limits: TemplateLimits = {
    ...input.engine.limits,
    renderLimit: input.limits?.renderLimit ?? input.engine.limits.renderLimit,
    memoryLimit: input.limits?.memoryLimit ?? input.engine.limits.memoryLimit,
    outputLimit: input.limits?.outputLimit ?? input.engine.limits.outputLimit,
  };

  for (const candidate of candidates) {
    try {
      const html = await input.engine.render(candidate.parsed, input.viewModel, input.runtime, {
        renderLimit: limits.renderLimit,
        memoryLimit: limits.memoryLimit,
      });
      const bytes = Buffer.byteLength(html, "utf8");

      if (bytes > limits.outputLimit) {
        throw new OutputLimitExceededError(bytes, limits.outputLimit);
      }

      return { html, template: candidate, violations };
    } catch (error) {
      if (!(error instanceof OutputLimitExceededError) && !isLimitViolation(error)) {
        throw error;
      }

      violations.push({
        template: input.name,
        theme: candidate.themeName,
        kind: error instanceof OutputLimitExceededError ? "output" : "render",
        message: describeError(error),
      });
    }
  }

  throw new TemplateRenderError(input.name, violations);
}
