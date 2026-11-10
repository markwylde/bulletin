import { createBoundedCache } from "@bulletin/cache";
import type { Template } from "liquidjs";
import type { TemplateEngine } from "./engine.ts";
import type { LoadedTheme, StoredThemeTemplate } from "./store.ts";

/** A template body that compiled, tied to the theme and version it came from. */
export interface CompiledThemeTemplate extends StoredThemeTemplate {
  readonly parsed: Template[];
}

/** Why a template did not render; reported to admins, never to the visitor (ADR 0008). */
export interface TemplateViolation {
  readonly template: string;
  /** The theme whose override caused the violation. */
  readonly theme: string;
  readonly kind: "compile" | "render" | "output" | "sanitise";
  readonly message: string;
}

export interface CompiledTheme {
  /** `themeId@version` (including ancestors) + template versions + plugin generation. */
  readonly key: string;
  readonly theme: LoadedTheme;
  /** Compile-time violations for this theme, surfaced with every render result. */
  readonly violations: readonly TemplateViolation[];
  /** Compiled overrides for a template name, leaf first (the fallback chain). */
  templates(name: string): readonly CompiledThemeTemplate[];
}

/** Default byte budget for compiled themes (ADR 0006: in-process caches are byte-bounded). */
export const DEFAULT_COMPILE_CACHE_BYTES = 64 * 1024 * 1024;

/** Per-entry bookkeeping so many tiny themes still count as retained memory. */
const CHAIN_ENTRY_OVERHEAD_BYTES = 96;

export interface CompileCacheOptions {
  /** Total retained bytes (source plus compiled AST); the default covers a board's themes. */
  readonly maxBytes?: number;
  readonly onViolation?: (violation: TemplateViolation) => void;
}

export interface CompileCache {
  /** Compiles a theme for a plugin generation, reusing the result until a version changes. */
  compile(theme: LoadedTheme, pluginsGeneration: number): CompiledTheme;
  readonly size: number;
  /** Retained bytes of every compiled theme, source and AST estimate included. */
  readonly bytes: number;
}

/** An estimate of the compiled AST's retained size; the source is charged separately. */
function astBytes(parsed: readonly Template[]): number {
  try {
    const json = JSON.stringify(parsed.map((template) => template.token));
    return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
  } catch {
    // A token that cannot be serialised still retains at least its source below.
    return 0;
  }
}

/** Retained bytes of one compiled theme: its key, chain records, source bodies and ASTs. */
function compiledThemeBytes(
  key: string,
  theme: LoadedTheme,
  templates: ReadonlyMap<string, readonly CompiledThemeTemplate[]>,
): number {
  let bytes = Buffer.byteLength(key, "utf8");

  for (const entry of theme.chain) {
    bytes += Buffer.byteLength(entry.name, "utf8") + CHAIN_ENTRY_OVERHEAD_BYTES;
  }

  for (const candidates of templates.values()) {
    for (const candidate of candidates) {
      bytes += Buffer.byteLength(candidate.body, "utf8") + astBytes(candidate.parsed);
    }
  }

  return bytes;
}

/**
 * A fingerprint of the theme's resolved content: its own and every ancestor's version plus
 * each template row's version. A template edit or a parent-theme edit changes it, so cached
 * pages and ETags cannot survive a live edit (ADR 0006, 0008).
 */
export function themeContentKey(theme: LoadedTheme): string {
  const chain = theme.chain.map((entry) => `${entry.id}@${entry.version}`).join("|");
  const templates = [...theme.templates.values()]
    .flat()
    .map((template) => `${template.themeId}/${template.name}@${template.version}`)
    .sort()
    .join(",");

  return `${chain}+${templates}`;
}

/**
 * The compile-cache key (ADR 0008): the resolved theme content plus the plugin generation.
 * Locale is deliberately absent: translators reach templates through the runtime.
 */
export function themeCacheKey(theme: LoadedTheme, pluginsGeneration: number): string {
  return `${themeContentKey(theme)}+plugins:${pluginsGeneration}`;
}

/**
 * Compiles theme templates once per version. A template that fails to compile is dropped from
 * the chain and reported, so the parent's version renders the page instead of a 500.
 */
export function createCompileCache(
  engine: TemplateEngine,
  options: CompileCacheOptions = {},
): CompileCache {
  const store = createBoundedCache<string, CompiledTheme>({
    maxBytes: options.maxBytes ?? DEFAULT_COMPILE_CACHE_BYTES,
  });

  return {
    compile(theme, pluginsGeneration) {
      const key = themeCacheKey(theme, pluginsGeneration);
      const cached = store.get(key);

      if (cached !== undefined) {
        return cached;
      }

      const violations: TemplateViolation[] = [];
      const templates = new Map<string, CompiledThemeTemplate[]>();

      for (const [name, candidates] of theme.templates) {
        const compiled: CompiledThemeTemplate[] = [];

        for (const candidate of candidates) {
          try {
            compiled.push({ ...candidate, parsed: engine.compile(candidate.body) });
          } catch (error) {
            const violation: TemplateViolation = {
              template: name,
              theme: candidate.themeName,
              kind: "compile",
              message: describeError(error),
            };
            violations.push(violation);
            options.onViolation?.(violation);
          }
        }

        if (compiled.length > 0) {
          templates.set(name, compiled);
        }
      }

      const themeCache: CompiledTheme = {
        key,
        theme,
        violations,
        templates(name) {
          return templates.get(name) ?? [];
        },
      };
      store.set(key, themeCache, compiledThemeBytes(key, theme, templates));
      return themeCache;
    },

    get size() {
      return store.size;
    },

    get bytes() {
      return store.bytes;
    },
  };
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
