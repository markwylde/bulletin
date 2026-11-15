import { queueSystemAudit } from "@bulletin/domain/audit";
import { parseCookieHeader } from "@bulletin/domain/auth";
import { embedProviderOrigins, listEmbedProviders } from "@bulletin/domain/content";
import { loadThemeResources, themeTranslator } from "@bulletin/domain/themes";
import { CODE_FLAG_DEFINITIONS } from "@bulletin/flags";
import type { Locale, Translator } from "@bulletin/i18n";
import { BP_COOKIE_NAME, type ColorScheme, parseBpCookie } from "@bulletin/i18n";
import {
  applyPluginOverrides,
  createCompileCache,
  createTemplateEngine,
  enforceHeadMarkup,
  HEAD_TEMPLATE_NAME,
  type LoadedTheme,
  loadPluginFragments,
  loadTheme,
  missingRenderedIslands,
  type RenderedThemePage,
  renderThemePage,
  renderThemeTemplate,
  TemplateRenderError,
  type TemplateRuntime,
  type TemplateViolation,
  type ThemeHeadSeo,
  type ThemeRegion,
} from "@bulletin/templates";
import { pluginAppIsland, SERVER_ISLANDS } from "@bulletin/ui/islands/server";
import type { SQL } from "bun";
import { configuredPluginOrigin } from "../plugins/config.ts";

/** The active theme; `themes` adds member and guest theme choice. */
export const THEME_NAME = "default";
/** Plugin generation until `plugin-platform` provides the real counter (ADR 0009). */
export { loadPluginsGeneration } from "@bulletin/templates";

/** Legacy default for tests and callers that do not pass a generation. */
export const PLUGIN_GENERATION = 1;

const engine = createTemplateEngine({
  islands: { ...SERVER_ISLANDS, PluginApp: pluginAppIsland(configuredPluginOrigin()) },
});
const compiledThemes = createCompileCache(engine);

export interface RouteDeclaration {
  readonly route: string;
  readonly requiredIslands: readonly string[];
}

export interface BreadcrumbItem {
  readonly label: string;
  readonly href: string | null;
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

export interface ThemeChooserView {
  readonly labels: {
    readonly theme: string;
    readonly scheme: string;
    readonly save: string;
    readonly failed: string;
    readonly system: string;
    readonly light: string;
    readonly dark: string;
  };
}

export function themeChooserView(translate: Translator): ThemeChooserView {
  return {
    labels: {
      theme: translate("theme.chooser.theme"),
      scheme: translate("theme.chooser.scheme"),
      save: translate("theme.chooser.save"),
      failed: translate("theme.chooser.failed"),
      system: translate("theme.chooser.system"),
      light: translate("theme.chooser.light"),
      dark: translate("theme.chooser.dark"),
    },
  };
}

/** Account templates and the side-nav entry each one highlights (ADR 0021). */
const ACCOUNT_NAV_ACTIVE: Readonly<Record<string, string>> = {
  account: "overview",
  "account-profile": "profile",
  "account-notifications": "notifications",
  "account-notification-preferences": "notificationPreferences",
  "account-follows": "follows",
  "account-attachments": "attachments",
  "account-privacy": "privacy",
  "account-api-keys": "apiKeys",
  "account-warnings": "warnings",
};

export interface PageRegionsInput {
  /** The page template; account templates also get the `accountNav` region. */
  readonly template?: string;
  readonly boardName: string;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly year?: number;
  /** The page view model; flags are shared with the header region. */
  readonly viewModel?: object;
}

/** The header, breadcrumb, empty-state and footer regions every themed page renders. */
export function pageRegions(input: PageRegionsInput): readonly ThemeRegion[] {
  const flags = (input.viewModel as { readonly flags?: unknown } | undefined)?.flags ?? {};
  const feeds = (flags as { readonly feeds?: unknown }).feeds === true;

  const accountActive = input.template === undefined ? undefined : ACCOUNT_NAV_ACTIVE[input.template];
  // The nav depends on flags and the page only, never on the member (ADR 0006).
  const accountNav: readonly ThemeRegion[] =
    accountActive === undefined
      ? []
      : [{ name: "account-nav", key: "accountNav", viewModel: { flags, active: accountActive } }];

  return [
    ...accountNav,
    {
      name: "header",
      // Never membership-dependent: a member and a guest with the same bits share this HTML.
      viewModel: {
        boardName: input.boardName,
        flags,
        language: languageSwitcherView(input.locale, input.translate),
        localeSuggestion: localeSuggestionView(input.locale, input.translate),
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
      viewModel: {
        boardName: input.boardName,
        year: input.year ?? new Date().getFullYear(),
        flags,
        // The language and appearance choices live in the footer, not the header (ADR 0021).
        language: languageSwitcherView(input.locale, input.translate),
        themeChooser: themeChooserView(input.translate),
        feedLinks: {
          flags: { feeds },
          labels: {
            label: input.translate("seo.feed.links"),
            rss: input.translate("seo.feed.link.rss"),
            atom: input.translate("seo.feed.link.atom"),
          },
        },
      },
    },
  ];
}

export interface ThemedPageInput {
  readonly sql: SQL;
  readonly boardName: string;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly template: string;
  readonly viewModel: object;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly route: RouteDeclaration;
  /** Fragment renders override the default page regions with none. */
  readonly regions?: readonly ThemeRegion[];
  /** Hook-fragment generation (ADR 0009); the demo route varies it for variants. */
  readonly pluginsGeneration?: number;
  /** A theme already loaded for the cache variant key, to avoid a second query. */
  readonly theme?: LoadedTheme | null;
  /** The viewer's preview or guest theme; null means the bundled default. */
  readonly themeId?: string | null | undefined;
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

/**
 * A template failure can repeat on every cache miss, so one admin-log row per signature per
 * window is enough; the goal is that staff see it, not a log of every request.
 */
const FAILURE_REPORT_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_REPORTED_SIGNATURES = 500;
const reportedFailures = new Map<string, number>();

/** Test and operations seam: forget throttled signatures so the next failure reports again. */
export function resetTemplateFailureReports(): void {
  reportedFailures.clear();
}

interface FailureReport {
  readonly action: string;
  readonly signature: string;
  readonly summary: Readonly<Record<string, unknown>>;
}

function shouldReport(signature: string, now: number): boolean {
  const last = reportedFailures.get(signature);

  if (last !== undefined && now - last < FAILURE_REPORT_INTERVAL_MS) {
    return false;
  }

  reportedFailures.set(signature, now);

  if (reportedFailures.size > MAX_REPORTED_SIGNATURES) {
    for (const key of [...reportedFailures.keys()].slice(
      0,
      reportedFailures.size - MAX_REPORTED_SIGNATURES,
    )) {
      reportedFailures.delete(key);
    }
  }

  return true;
}

/** Queues failures for the staff app's admin log; a reporting error never breaks a page. */
async function recordFailures(sql: SQL, failures: readonly FailureReport[]): Promise<void> {
  const now = Date.now();
  const seen = new Set<string>();

  for (const failure of failures) {
    if (seen.has(failure.signature) || !shouldReport(failure.signature, now)) {
      continue;
    }

    seen.add(failure.signature);

    try {
      await queueSystemAudit(sql, {
        action: failure.action,
        targetType: "theme_template",
        summary: failure.summary,
      });
    } catch (error) {
      console.warn("[theme] could not record the template failure", error);
    }
  }
}

function violationReports(violations: readonly TemplateViolation[]): readonly FailureReport[] {
  return violations.map((violation) => ({
    action: `theme.${violation.kind}`,
    signature: `${violation.kind}|${violation.theme}|${violation.template}|${violation.message}`,
    summary: {
      theme: violation.theme,
      template: violation.template,
      kind: violation.kind,
      message: violation.message,
    },
  }));
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
const RENDER_FLAG_DEFAULTS: Readonly<Record<string, boolean>> = Object.fromEntries(
  CODE_FLAG_DEFINITIONS.map((definition) => [definition.key, false]),
);

/** Templates always see every render flag the theme may test (Liquid strict variables). */
function withFlagDefaults(viewModel: object): object {
  const provided = (viewModel as { readonly flags?: unknown }).flags;
  const flags =
    typeof provided === "object" && provided !== null ? (provided as Record<string, unknown>) : {};

  return { ...viewModel, flags: { ...RENDER_FLAG_DEFAULTS, ...flags } };
}

export async function renderThemedPage(input: ThemedPageInput): Promise<ThemedPage> {
  const theme = input.theme ?? (await loadActiveTheme(input.sql, input.themeId));

  if (theme === null || theme === undefined) {
    throw new ThemeNotInstalledError();
  }

  const generation = input.pluginsGeneration ?? PLUGIN_GENERATION;
  const requestedFlags = (input.viewModel as { readonly flags?: unknown }).flags;
  const pluginsEnabled =
    typeof requestedFlags === "object" &&
    requestedFlags !== null &&
    (requestedFlags as { readonly plugins?: unknown }).plugins === true;
  const fragments = pluginsEnabled
    ? await loadPluginFragments(input.sql, generation)
    : { hooks: {}, overrides: [] };
  const activeTheme = applyPluginOverrides(theme, fragments.overrides);
  const errors: string[] = [];
  const failures: FailureReport[] = [];
  const resources = await loadThemeResources(
    input.sql,
    activeTheme.chain.map((entry) => entry.id),
  );
  const translate = themeTranslator(input.locale, resources.strings[input.locale], input.translate);
  const runtime: TemplateRuntime = {
    translate,
    hooks: fragments.hooks,
    report: (message) => {
      errors.push(message);
      console.warn(`[theme] ${message}`);
      // Island failures (unknown, invalid props, render error) arrive here, not as violations.
      failures.push({
        action: "theme.island.error",
        signature: `island|${input.template}|${message}`,
        summary: { route: input.route.route, template: input.template, message },
      });
    },
  };
  const compiled = compiledThemes.compile(activeTheme, generation);
  // Content embeds stay in the page only when their frame origin is an enabled provider
  // (ADR 0007, 0008). Provider changes are rare, and this runs on a cache miss only.
  const trustedFrameOrigins = embedProviderOrigins(
    await listEmbedProviders(input.sql).catch(() => []),
  );
  let page: RenderedThemePage;
  const viewModel = withFlagDefaults(input.viewModel);

  try {
    page = await renderThemePage({
      engine,
      compiled,
      name: input.template,
      viewModel,
      runtime,
      regions: input.regions ?? pageRegions({ ...input, translate, viewModel }),
      trustedFrameOrigins,
    });
  } catch (error) {
    // A template that failed to compile never reaches `page.violations`; report it before the
    // page fails so staff still see why the theme is broken.
    if (error instanceof TemplateRenderError) {
      await recordFailures(input.sql, violationReports(error.violations));
    }

    throw error;
  }

  report(page.violations, errors);
  failures.push(...violationReports(page.violations));

  for (const island of missingRenderedIslands(page.html, input.route.requiredIslands)) {
    const message = `required island "${island}" is missing from route "${input.route.route}"`;
    errors.push(message);
    console.warn(`[theme] ${message}`);
    failures.push({
      action: "theme.island.missing",
      signature: `missing|${input.route.route}|${island}`,
      summary: { route: input.route.route, island },
    });
  }

  // Compile-time violations on this theme (e.g. an over-limit override) also count even when a
  // parent template rendered the page.
  failures.push(...violationReports(compiled.violations));

  await recordFailures(input.sql, failures);

  return { html: page.html, errors };
}

export interface ThemeHeadInput {
  readonly sql: SQL;
  readonly themeId?: string | null | undefined;
  readonly pluginsGeneration: number;
  readonly translate: Translator;
  readonly boardName: string;
  readonly seo: ThemeHeadSeo;
}

/**
 * Renders the theme's `head` template for one response (change `seo-feeds`), then applies the
 * required-meta check. It runs per response, after the cached body, because the canonical and
 * `hreflang` set depend on the request URL (`?lang=`) and origin, not only on the variant.
 * Any template failure, or a theme without a `head` template, falls back to the trusted tags.
 */
export async function renderThemeHead(input: ThemeHeadInput): Promise<string> {
  const failures: FailureReport[] = [];
  let html = "";

  try {
    const theme = await loadActiveTheme(input.sql, input.themeId);

    if (theme !== null) {
      const rendered = await renderThemeTemplate({
        engine,
        compiled: compiledThemes.compile(theme, input.pluginsGeneration),
        name: HEAD_TEMPLATE_NAME,
        viewModel: { seo: input.seo, boardName: input.boardName },
        runtime: {
          translate: input.translate,
          hooks: {},
          report: (message) => console.warn(`[theme] head: ${message}`),
        },
      });

      html = rendered.html;
      failures.push(...violationReports(rendered.violations));
    }
  } catch (error) {
    console.warn("[theme] the head template failed; using the trusted metadata", error);
    failures.push({
      action: "theme.head.error",
      signature: `head|error|${error instanceof Error ? error.message : String(error)}`,
      summary: {
        template: HEAD_TEMPLATE_NAME,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }

  const enforced = enforceHeadMarkup(html, input.seo);

  if (html !== "" && enforced.problems.length > 0) {
    console.warn(`[theme] head: ${enforced.problems.join("; ")}`);
    failures.push({
      action: "theme.head.required_meta",
      signature: `head|meta|${input.themeId ?? THEME_NAME}|${enforced.problems.join("|")}`,
      summary: { template: HEAD_TEMPLATE_NAME, problems: enforced.problems },
    });
  }

  await recordFailures(input.sql, failures);

  return enforced.html;
}

/**
 * Loads the theme the viewer should see: a preview grant or the guest's validated `bp` choice,
 * falling back to the bundled default (ADR 0006, 0008).
 */
export async function loadActiveTheme(
  sql: SQL,
  themeId?: string | null,
): Promise<LoadedTheme | null> {
  if (themeId !== undefined && themeId !== null && /^\d+$/.test(themeId)) {
    const theme = await loadTheme(sql, themeId);

    if (theme !== null) {
      return theme;
    }
  }

  return loadTheme(sql, THEME_NAME);
}

/** CSS custom properties and custom CSS for the active theme; empty for the bundled default. */
export function themeCss(resources: {
  readonly tokens: Readonly<Record<"light" | "dark", Readonly<Record<string, string>>>>;
  readonly css: string;
}): string {
  const declarations = (scheme: "light" | "dark"): string =>
    Object.entries(resources.tokens[scheme])
      .map(([token, value]) => `  --bl-${token}: ${value};`)
      .join("\n");
  const light = declarations("light");
  const dark = declarations("dark");
  const blocks: string[] = [];

  if (light !== "") {
    blocks.push(`:root {\n${light}\n}`);
  }

  if (dark !== "") {
    blocks.push(`@media (prefers-color-scheme: dark) {\n  :root {\n${dark}\n  }\n}`);
    blocks.push(`:root[data-scheme="dark"] {\n${dark}\n}`);
  }

  if (light !== "") {
    blocks.push(`:root[data-scheme="light"] {\n${light}\n}`);
  }

  if (resources.css.trim() !== "") {
    blocks.push(resources.css);
  }

  return blocks.join("\n");
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
