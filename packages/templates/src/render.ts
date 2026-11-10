import type { CompiledTheme, CompiledThemeTemplate, TemplateViolation } from "./compile.ts";
import { describeError } from "./compile.ts";
import type { TemplateEngine, TemplateLimits } from "./engine.ts";
import { OutputLimitExceededError } from "./engine.ts";
import type { TemplateRuntime } from "./runtime.ts";
import { sanitiseRenderedMarkup } from "./sanitise.ts";

export interface RenderTemplateInput {
  readonly engine: TemplateEngine;
  readonly compiled: CompiledTheme;
  /** Template name to render, e.g. `page` or `footer`. */
  readonly name: string;
  readonly viewModel: object;
  readonly runtime: TemplateRuntime;
  /** Exact allowlisted embed origins a content pipeline player may frame (ADR 0007, 0008). */
  readonly trustedFrameOrigins?: readonly string[];
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

function errorChain(error: unknown): readonly Error[] {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const chain: Error[] = [];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!(current instanceof Error) || seen.has(current)) {
      continue;
    }

    seen.add(current);
    chain.push(current);

    const original = (current as { originalError?: unknown }).originalError;

    if (original !== undefined) {
      queue.push(original);
    }

    const nested = (current as { errors?: unknown }).errors;

    if (Array.isArray(nested)) {
      queue.push(...nested);
    }
  }

  return chain;
}

/**
 * True for LiquidJS resource-limit failures (render, memory and parse limits throw an
 * `AssertionError` whose message ends in "limit exceeded", wrapped by the engine). ADR 0008:
 * a template that exceeds a limit falls back to the parent theme's version.
 */
export function isLimitViolation(error: unknown): boolean {
  return errorChain(error).some((current) => /limit exceeded/i.test(current.message));
}

/** True when the emitter stopped at the byte budget, even after Liquid wraps the error. */
export function isOutputLimitViolation(error: unknown): boolean {
  return errorChain(error).some((current) => current instanceof OutputLimitExceededError);
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
        outputLimit: limits.outputLimit,
      });
      // ADR 0008: re-sanitise every rendered fragment before it is cached or served.
      const sanitised = sanitiseRenderedMarkup(
        html,
        input.trustedFrameOrigins === undefined
          ? {}
          : { trustedFrameOrigins: input.trustedFrameOrigins },
      );

      if (sanitised.removed.length > 0) {
        violations.push({
          template: input.name,
          theme: candidate.themeName,
          kind: "sanitise",
          message: `removed ${sanitised.removed.join(", ")}`,
        });
      }

      return { html: sanitised.html, template: candidate, violations };
    } catch (error) {
      const outputViolation = isOutputLimitViolation(error);

      if (!outputViolation && !isLimitViolation(error)) {
        throw error;
      }

      violations.push({
        template: input.name,
        theme: candidate.themeName,
        kind: outputViolation ? "output" : "render",
        message: describeError(error),
      });
    }
  }

  throw new TemplateRenderError(input.name, violations);
}
