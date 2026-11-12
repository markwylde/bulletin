import {
  type ThemeBundleManifest,
  type ThemeBundleString,
  validateTokenInput,
} from "@bulletin/domain/themes";
import { filterThemeCss } from "@bulletin/domain/themes/css";
import { type Catalog, isLocale, validateRuntimeCatalog } from "@bulletin/i18n";
import {
  checkThemeContrast,
  createTemplateEngine,
  DEFAULT_THEME_TEMPLATE_NAMES,
  declaredHooks,
  declaredIslandsIn,
  HOOK_NAMES,
  loadDefaultThemeTokens,
  type TemplateIssue,
  validateTemplateMarkup,
} from "@bulletin/templates";

const engine = createTemplateEngine({ islands: {} });

export type ThemeCheckIssue =
  | {
      readonly code: "missing_template";
      readonly template: string;
    }
  | {
      readonly code: "invalid_template";
      readonly template: string;
      readonly issues: readonly TemplateIssue[];
      readonly parseError: string | null;
      readonly unknownHooks: readonly string[];
    }
  | {
      readonly code: "missing_island";
      readonly template: string;
      readonly island: string;
    }
  | {
      readonly code: "invalid_css";
      readonly cssCode: string;
      readonly detail?: string;
    }
  | {
      readonly code: "invalid_tokens";
      readonly scheme: string;
    }
  | {
      readonly code: "contrast";
      readonly scheme: string;
      readonly foreground: string;
      readonly background: string;
      readonly ratio: number | null;
    }
  | {
      readonly code: "invalid_string";
      readonly locale: string;
      readonly key: string;
      readonly message: string;
    };

/** Islands every theme route must place. `Editor` is required on topic pages (ADR 0008). */
export const REQUIRED_THEME_ISLANDS: Readonly<Record<string, readonly string[]>> = {
  header: ["LanguageSwitcher"],
  topic: ["Editor"],
};

export interface ThemeCheckResult {
  readonly ok: boolean;
  readonly issues: readonly ThemeCheckIssue[];
  readonly css: string;
}

function checkTemplate(name: string, body: string): readonly ThemeCheckIssue[] {
  const validation = validateTemplateMarkup(body);
  let parseError: string | null = null;

  try {
    engine.compile(body);
  } catch (error) {
    parseError = error instanceof Error ? error.message : "The template could not be parsed.";
  }

  const unknownHooks = declaredHooks(body).filter((hook) => !HOOK_NAMES.includes(hook));
  const issues: ThemeCheckIssue[] = [];

  if (validation.issues.length > 0 || parseError !== null || unknownHooks.length > 0) {
    issues.push({
      code: "invalid_template",
      template: name,
      issues: validation.issues,
      parseError,
      unknownHooks,
    });
  }

  const declared = new Set(declaredIslandsIn({ [name]: body }));

  for (const island of REQUIRED_THEME_ISLANDS[name] ?? []) {
    if (!declared.has(island)) {
      issues.push({ code: "missing_island", template: name, island });
    }
  }

  return issues;
}

function checkStrings(
  strings: readonly ThemeBundleString[],
  base: Catalog | null,
): readonly ThemeCheckIssue[] {
  const issues: ThemeCheckIssue[] = [];

  for (const entry of strings) {
    if (!isLocale(entry.locale)) {
      issues.push({
        code: "invalid_string",
        locale: String(entry.locale),
        key: entry.key,
        message: "Unknown locale",
      });
      continue;
    }

    if (base !== null) {
      const validation = validateRuntimeCatalog({
        locale: entry.locale,
        base,
        catalog: { [entry.key]: entry.value },
      });

      for (const issue of validation.issues) {
        issues.push({
          code: "invalid_string",
          locale: entry.locale,
          key: entry.key,
          message: issue.message,
        });
      }
    }
  }

  return issues;
}

/**
 * Every static check an installed theme must pass (ADR 0008, task 3.2): required templates,
 * template markup/parse/hooks, required islands, CSS filter, token contrast and strings.
 */
export async function checkThemeBundle(
  manifest: ThemeBundleManifest,
  baseCatalog: Catalog | null,
): Promise<ThemeCheckResult> {
  const issues: ThemeCheckIssue[] = [];
  const provided = Object.keys(manifest.templates);

  if (manifest.parent === null) {
    for (const template of DEFAULT_THEME_TEMPLATE_NAMES) {
      if (!provided.includes(template)) {
        issues.push({ code: "missing_template", template });
      }
    }
  }

  for (const [name, body] of Object.entries(manifest.templates)) {
    issues.push(...checkTemplate(name, body));
  }

  for (const scheme of ["light", "dark"] as const) {
    const tokens = validateTokenInput({
      scheme,
      tokens: manifest.tokens[scheme],
    });

    if (tokens === null) {
      issues.push({ code: "invalid_tokens", scheme });
    }
  }

  const defaults = await loadDefaultThemeTokens();
  const mergedTokens = {
    light: { ...defaults.light, ...manifest.tokens.light },
    dark: { ...defaults.dark, ...manifest.tokens.dark },
  };

  for (const issue of checkThemeContrast(mergedTokens)) {
    issues.push({
      code: "contrast",
      scheme: issue.scheme,
      foreground: issue.foreground,
      background: issue.background,
      ratio: issue.ratio,
    });
  }

  const filtered = filterThemeCss(manifest.css);

  if (!filtered.ok) {
    issues.push({
      code: "invalid_css",
      cssCode: filtered.code,
      ...(filtered.detail === undefined ? {} : { detail: filtered.detail }),
    });
  }

  issues.push(...checkStrings(manifest.strings, baseCatalog));

  return {
    ok: issues.length === 0,
    issues,
    css: filtered.ok ? filtered.css : "",
  };
}
