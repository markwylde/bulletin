import {
  loadThemeResources,
  type ThemeBundleManifest,
  type ThemeBundleString,
  validateTokenInput,
} from "@bulletin/domain/themes";
import { filterThemeCss, responsiveCssIssues } from "@bulletin/domain/themes/css";
import { type Catalog, isLocale, validateRuntimeCatalog } from "@bulletin/i18n";
import {
  checkThemeContrast,
  createTemplateEngine,
  DEFAULT_THEME_TEMPLATE_NAMES,
  declaredHooks,
  declaredIslandsIn,
  HOOK_NAMES,
  loadDefaultThemeTokens,
  loadTheme,
  type TemplateIssue,
  validateTemplateMarkup,
} from "@bulletin/templates";
import type { SQL } from "bun";

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
    }
  | {
      readonly code: "responsive";
      readonly property: string;
      readonly value: string;
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
  } else {
    for (const issue of responsiveCssIssues(filtered.css)) {
      issues.push({ code: "responsive", ...issue });
    }
  }

  issues.push(...checkStrings(manifest.strings, baseCatalog));

  return {
    ok: issues.length === 0,
    issues,
    css: filtered.ok ? filtered.css : "",
  };
}

/** Re-checks the resolved theme after a template save/restore/revert (task 6 review). */
export async function checkResolvedTemplateChange(
  sql: SQL,
  input: { readonly themeId: string; readonly name: string; readonly body: string | null },
): Promise<readonly ThemeCheckIssue[]> {
  const loaded = await loadTheme(sql, input.themeId);

  if (loaded === null) {
    return [{ code: "missing_template", template: input.name }];
  }

  const resolved = new Map(
    [...loaded.templates.entries()].flatMap(([name, candidates]) => {
      const first = candidates[0];
      return first === undefined ? [] : [[name, first.body] as const];
    }),
  );
  const candidates = loaded.templates.get(input.name) ?? [];

  if (input.body === null) {
    const inherited = candidates[1];

    if (inherited === undefined) {
      resolved.delete(input.name);
    } else {
      resolved.set(input.name, inherited.body);
    }
  } else {
    resolved.set(input.name, input.body);
  }

  const issues: ThemeCheckIssue[] =
    input.body === null ? [] : [...checkTemplate(input.name, input.body)];
  const seen = new Set(
    issues.map(
      (issue) =>
        `${issue.code}:${"template" in issue ? issue.template : ""}:${
          "island" in issue ? issue.island : ""
        }`,
    ),
  );

  for (const [name, required] of Object.entries(REQUIRED_THEME_ISLANDS)) {
    const body = resolved.get(name);

    if (body === undefined) {
      continue;
    }

    const declared = new Set(declaredIslandsIn({ [name]: body }));

    for (const island of required) {
      const key = `missing_island:${name}:${island}`;

      if (!declared.has(island) && !seen.has(key)) {
        seen.add(key);
        issues.push({ code: "missing_island", template: name, island });
      }
    }
  }

  return issues;
}

/** Re-checks WCAG contrast after a token save. */
export async function checkResolvedTokenChange(
  sql: SQL,
  input: {
    readonly themeId: string;
    readonly scheme: "light" | "dark";
    readonly tokens: Readonly<Record<string, string>>;
  },
): Promise<readonly ThemeCheckIssue[]> {
  const loaded = await loadTheme(sql, input.themeId);

  if (loaded === null) {
    return [{ code: "invalid_tokens", scheme: input.scheme }];
  }

  const resources = await loadThemeResources(
    sql,
    loaded.chain.map((entry) => entry.id),
  );
  const defaults = await loadDefaultThemeTokens();
  const merged = {
    light: { ...defaults.light, ...resources.tokens.light },
    dark: { ...defaults.dark, ...resources.tokens.dark },
  };
  merged[input.scheme] = { ...merged[input.scheme], ...input.tokens };

  return checkThemeContrast(merged).map((issue) => ({
    code: "contrast" as const,
    scheme: issue.scheme,
    foreground: issue.foreground,
    background: issue.background,
    ratio: issue.ratio,
  }));
}
