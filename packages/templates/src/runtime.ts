import type { Translator } from "@bulletin/i18n";
import type { Context } from "liquidjs";
import type { HookFragments } from "./hook-tag.ts";

/**
 * Per-render collaborators: the request's translator and the plugin fragments for the current
 * generation. Passing them through the render context (not the engine) is what lets compiled
 * templates be shared by every locale (ADR 0008: keyed by theme version + plugin generation).
 */
export interface TemplateRuntime {
  readonly translate: Translator;
  readonly hooks: HookFragments;
  /** Receives rejection and fallback reports for admins; never rendered to the visitor. */
  readonly report?: (message: string) => void;
}

/** Reserved globals key; themes never see it unless they reference it by name. */
export const TEMPLATE_RUNTIME_KEY = "__bulletinRuntime";

export function runtimeGlobals(runtime: TemplateRuntime): Readonly<Record<string, unknown>> {
  return { [TEMPLATE_RUNTIME_KEY]: runtime };
}

export function isTemplateRuntime(value: unknown): value is TemplateRuntime {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<TemplateRuntime>;

  return (
    typeof candidate.translate === "function" &&
    typeof candidate.hooks === "object" &&
    candidate.hooks !== null
  );
}

/** Reads the runtime a template is being rendered with; missing runtime is a bug, not a theme error. */
export function readRuntime(context: Context): TemplateRuntime {
  const runtime = (context.globals as Record<string, unknown>)[TEMPLATE_RUNTIME_KEY];

  if (!isTemplateRuntime(runtime)) {
    throw new Error("Template rendered without a Bulletin runtime");
  }

  return runtime;
}
