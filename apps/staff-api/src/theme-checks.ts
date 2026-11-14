import {
  loadThemeResources,
  type ThemeBundleManifest,
  type ThemeBundleString,
  validateTokenInput,
} from "@bulletin/domain/themes";
import {
  cssValueHasResource,
  filterThemeCss,
  responsiveCssIssues,
  responsiveStyleIssue,
} from "@bulletin/domain/themes/css";
import { type Catalog, isLocale, validateRuntimeCatalog } from "@bulletin/i18n";
import {
  checkThemeContrast,
  createTemplateEngine,
  DEFAULT_THEME_TEMPLATE_NAMES,
  declaredHooks,
  declaredIslandsIn,
  HEAD_TEMPLATE_NAME,
  HOOK_NAMES,
  loadDefaultThemeTokens,
  loadTheme,
  maskLiquid,
  type TemplateIssue,
  type ThemeTokens,
  validateHeadTemplate,
  validateTemplateMarkup,
} from "@bulletin/templates";
import type { SQL } from "bun";
import { parse } from "parse5";

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
      /** The `head` template must render a title, robots meta and canonical link (seo-feeds). */
      readonly code: "missing_meta";
      readonly template: string;
      readonly meta: "canonical" | "robots" | "title";
    }
  | {
      /** The `head` template may contain only title, meta and canonical/alternate links. */
      readonly code: "head_element";
      readonly template: string;
      readonly element: string;
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
      readonly template?: string;
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

interface StaticNode {
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly StaticNode[];
  readonly content?: { readonly childNodes?: readonly StaticNode[] };
}

function staticLayoutIssues(name: string, body: string): readonly ThemeCheckIssue[] {
  const issues: ThemeCheckIssue[] = [];
  const root = parse(maskLiquid(body)) as unknown as StaticNode;

  const walk = (node: StaticNode): void => {
    for (const attribute of node.attrs ?? []) {
      if (attribute.name === "style") {
        for (const declaration of attribute.value.split(";")) {
          const [property, value] = declaration.split(":", 2);

          if (property === undefined || value === undefined) {
            continue;
          }

          const issue = responsiveStyleIssue(property, value);

          if (issue !== null) {
            issues.push({ code: "responsive", ...issue, template: name });
          }
        }
      }

      if (attribute.name === "width" && /^\d+$/.test(attribute.value.trim())) {
        const width = Number(attribute.value.trim());

        if (width > 360) {
          issues.push({
            code: "responsive",
            property: "width",
            value: `${width}px`,
            template: name,
          });
        }
      }
    }

    for (const child of node.childNodes ?? node.content?.childNodes ?? []) {
      walk(child);
    }
  };

  walk(root);
  return issues;
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

  issues.push(...staticLayoutIssues(name, body));

  if (name === HEAD_TEMPLATE_NAME) {
    for (const issue of validateHeadTemplate(body)) {
      issues.push(
        issue.code === "missing_meta"
          ? { code: "missing_meta", template: name, meta: issue.meta }
          : { code: "head_element", template: name, element: issue.element },
      );
    }
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
  baseTokens?: ThemeTokens,
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

    if (tokens === null || Object.values(manifest.tokens[scheme]).some(cssValueHasResource)) {
      issues.push({ code: "invalid_tokens", scheme });
    }
  }

  const defaults = baseTokens ?? (await loadDefaultThemeTokens());
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

    issues.push(...staticLayoutIssues(name, body));

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
  if (Object.values(input.tokens).some(cssValueHasResource)) {
    return [{ code: "invalid_tokens", scheme: input.scheme }];
  }

  const loaded = await loadTheme(sql, input.themeId);

  if (loaded === null) {
    return [{ code: "invalid_tokens", scheme: input.scheme }];
  }

  const [resources, ancestors] = await Promise.all([
    loadThemeResources(
      sql,
      loaded.chain.map((entry) => entry.id),
    ),
    loadThemeResources(
      sql,
      loaded.chain.slice(1).map((entry) => entry.id),
    ),
  ]);
  const defaults = await loadDefaultThemeTokens();
  const other = input.scheme === "light" ? "dark" : "light";
  // The saved row replaces this scheme entirely, so validate the proposed set over the
  // ancestors' inherited tokens. The untouched scheme keeps the theme's current row.
  const merged = {
    light: { ...defaults.light, ...ancestors.tokens.light },
    dark: { ...defaults.dark, ...ancestors.tokens.dark },
  };
  merged[other] = { ...merged[other], ...resources.tokens[other] };
  merged[input.scheme] = { ...merged[input.scheme], ...input.tokens };

  return checkThemeContrast(merged).map((issue) => ({
    code: "contrast" as const,
    scheme: issue.scheme,
    foreground: issue.foreground,
    background: issue.background,
    ratio: issue.ratio,
  }));
}
