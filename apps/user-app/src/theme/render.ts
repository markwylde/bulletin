import { parseCookieHeader } from "@bulletin/domain/auth";
import type { Locale, Translator } from "@bulletin/i18n";
import { BP_COOKIE_NAME, type ColorScheme, parseBpCookie } from "@bulletin/i18n";
import {
  createCompileCache,
  createTemplateEngine,
  type LoadedTheme,
  loadHookFragments,
  loadTheme,
  missingRenderedIslands,
  renderThemePage,
  type TemplateRuntime,
  type TemplateViolation,
  type ThemeRegion,
} from "@bulletin/templates";
import { SERVER_ISLANDS } from "@bulletin/ui/islands/server";
import type { SQL } from "bun";

/** The active theme; `themes` adds member and guest theme choice. */
export const THEME_NAME = "default";
/** Plugin generation until `plugin-platform` provides the real counter (ADR 0009). */
export const PLUGIN_GENERATION = 1;

const engine = createTemplateEngine({ islands: SERVER_ISLANDS });
const compiledThemes = createCompileCache(engine);

export interface RouteDeclaration {
  readonly route: string;
  readonly requiredIslands: readonly string[];
}

export interface BreadcrumbItem {
  readonly label: string;
  readonly href: string | null;
}

export interface Viewer {
  readonly isMember: boolean;
  readonly displayName: string | null;
}

export interface LanguageSwitcherView {
  readonly current: Locale;
  readonly options: readonly { readonly value: Locale; readonly label: string }[];
  readonly label: string;
  readonly nameRequired: string;
  readonly saveFailed: string;
}

export interface LocaleSuggestionView {
  readonly current: Locale;
  readonly options: readonly { readonly value: Locale; readonly label: string }[];
  readonly message: string;
  readonly accept: string;
  readonly dismiss: string;
}

function languageOptions(translate: Translator): LanguageSwitcherView["options"] {
  // Literal keys, so the i18n catalog check can see them.
  return [
    { value: "en", label: translate("language.name.en") },
    { value: "es", label: translate("language.name.es") },
    { value: "fr", label: translate("language.name.fr") },
  ];
}

/** Props for the language switcher island, used by the header and the account page. */
export function languageSwitcherView(locale: Locale, translate: Translator): LanguageSwitcherView {
  return {
    current: locale,
    options: languageOptions(translate),
    label: translate("language.label"),
    nameRequired: translate("language.nameRequired"),
    saveFailed: translate("language.saveFailed"),
  };
}

/** Props for the client-side suggestion banner; guests only, never members (ADR 0006). */
export function localeSuggestionView(locale: Locale, translate: Translator): LocaleSuggestionView {
  return {
    current: locale,
    options: languageOptions(translate),
    message: translate("language.suggestion.message"),
    accept: translate("language.suggestion.accept"),
    dismiss: translate("language.suggestion.dismiss"),
  };
}

export interface PageRegionsInput {
  readonly boardName: string;
  readonly viewer: Viewer;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly year?: number;
}

/** The header, breadcrumb, empty-state and footer regions every themed page renders. */
export function pageRegions(input: PageRegionsInput): readonly ThemeRegion[] {
  return [
    {
      name: "header",
      viewModel: {
        boardName: input.boardName,
        isMember: input.viewer.isMember,
        language: languageSwitcherView(input.locale, input.translate),
        localeSuggestion: input.viewer.isMember
          ? null
          : localeSuggestionView(input.locale, input.translate),
      },
    },
    {
      name: "breadcrumbs",
      viewModel: { items: input.breadcrumbs },
    },
    {
      // Exposed as `emptyState`: Liquid treats `empty` as a built-in literal in `{{ }}`.
      name: "empty",
      key: "emptyState",
      viewModel: {
        title: input.translate("theme.empty.title"),
        body: input.translate("theme.empty.body"),
      },
    },
    {
      name: "footer",
      viewModel: { boardName: input.boardName, year: input.year ?? new Date().getFullYear() },
    },
  ];
}

export interface ThemedPageInput {
  readonly sql: SQL;
  readonly boardName: string;
  readonly viewer: Viewer;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly template: string;
  readonly viewModel: object;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly route: RouteDeclaration;
  /** Hook-fragment generation (ADR 0009); the demo route varies it for variants. */
  readonly pluginsGeneration?: number;
  /** A theme already loaded for the cache variant key, to avoid a second query. */
  readonly theme?: LoadedTheme | null;
}

export interface ThemedPage {
  readonly html: string;
  readonly errors: readonly string[];
}

export class ThemeNotInstalledError extends Error {
  constructor() {
    super("The default theme is not installed in the database");
    this.name = "ThemeNotInstalledError";
  }
}

function report(violations: readonly TemplateViolation[], errors: string[]): void {
  for (const violation of violations) {
    errors.push(
      `${violation.kind}: ${violation.theme}/${violation.template}: ${violation.message}`,
    );
    console.warn(`[theme] ${violation.kind} ${violation.theme}/${violation.template}`);
  }
}

/**
 * Renders one page through the default theme (ADR 0008). Theme violations and missing
 * required islands are reported to the caller and logged; the page still renders.
 */
export async function renderThemedPage(input: ThemedPageInput): Promise<ThemedPage> {
  const theme = input.theme ?? (await loadTheme(input.sql, THEME_NAME));

  if (theme === null || theme === undefined) {
    throw new ThemeNotInstalledError();
  }

  const generation = input.pluginsGeneration ?? PLUGIN_GENERATION;
  const errors: string[] = [];
  const runtime: TemplateRuntime = {
    translate: input.translate,
    hooks: await loadHookFragments(input.sql, generation),
    report: (message) => {
      errors.push(message);
      console.warn(`[theme] ${message}`);
    },
  };
  const compiled = compiledThemes.compile(theme, generation);
  const page = await renderThemePage({
    engine,
    compiled,
    name: input.template,
    viewModel: input.viewModel,
    runtime,
    regions: pageRegions(input),
  });

  report(page.violations, errors);

  for (const island of missingRenderedIslands(page.html, input.route.requiredIslands)) {
    errors.push(`required island "${island}" is missing from route "${input.route.route}"`);
    console.warn(`[theme] required island "${island}" missing from ${input.route.route}`);
  }

  return { html: page.html, errors };
}

/** Loads the active theme for the cache variant key (default theme until `themes`). */
export function loadActiveTheme(sql: SQL): Promise<LoadedTheme | null> {
  return loadTheme(sql, THEME_NAME);
}

/** The guest's colour scheme from the normalised `bp` cookie (ADR 0006). */
export function requestColourScheme(cookieHeader: string | null): ColorScheme {
  const bp = parseCookieHeader(cookieHeader)[BP_COOKIE_NAME];
  return parseBpCookie(bp).scheme;
}

/** The board's name as pages show it, falling back to the shipped name. */
export function boardNameFrom(boardName: string | null | undefined, translate: Translator): string {
  const configured = boardName?.trim() ?? "";
  return configured === "" ? translate("common.siteName") : configured;
}
