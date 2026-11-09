import { IntlMessageFormat } from "intl-messageformat";
import { CATALOGS, type Catalog, DEFAULT_LOCALE, type Locale } from "./catalog.ts";

export interface CompletenessReport {
  readonly totalKeys: number;
  readonly presentKeys: number;
  readonly missingKeys: readonly string[];
  readonly percentage: number;
}

export type RuntimeCatalogIssueCode =
  | "foreign_key"
  | "invalid_icu"
  | "placeholder_mismatch"
  | "unknown_key"
  | "unsupported_tag";

export interface RuntimeCatalogIssue {
  readonly code: RuntimeCatalogIssueCode;
  readonly key: string;
  readonly message: string;
  readonly missingPlaceholders?: readonly string[];
  readonly extraPlaceholders?: readonly string[];
}

export interface RuntimeCatalogValidation {
  readonly locale: Locale;
  readonly issues: readonly RuntimeCatalogIssue[];
  readonly completeness: CompletenessReport;
}

export interface PluginMessages {
  readonly id: string;
  readonly catalogs: Partial<Record<Locale, Catalog>>;
}

export interface RuntimeMessageInput {
  readonly key: string;
  readonly locale: Locale;
  readonly overrides?: Catalog;
  readonly theme?: Catalog;
  readonly plugin?: PluginMessages;
  readonly shipped?: Partial<Record<Locale, Catalog>>;
}

export function pluginMessagePrefix(pluginId: string): string {
  return `plugin.${pluginId}.`;
}

/** Plugin strings may only live under their own `plugin.<id>.` namespace. */
export function isPluginMessageKey(pluginId: string, key: string): boolean {
  const prefix = pluginMessagePrefix(pluginId);
  return key.startsWith(prefix) && key.length > prefix.length;
}

const LITERAL_TYPE = 0;
const POUND_TYPE = 7;
const TAG_TYPE = 8;

interface MessageAnalysis {
  readonly placeholders: ReadonlySet<string>;
  readonly tags: ReadonlySet<string>;
}

function collectPlaceholders(nodes: unknown, placeholders: Set<string>, tags: Set<string>): void {
  if (!Array.isArray(nodes)) {
    return;
  }

  for (const node of nodes) {
    if (typeof node !== "object" || node === null) {
      continue;
    }

    const element = node as {
      readonly type?: unknown;
      readonly value?: unknown;
      readonly options?: unknown;
      readonly children?: unknown;
    };

    if (typeof element.type === "number" && typeof element.value === "string") {
      if (element.type === TAG_TYPE) {
        tags.add(element.value);
      } else if (element.type !== LITERAL_TYPE && element.type !== POUND_TYPE) {
        placeholders.add(element.value);
      }
    }

    if (typeof element.options === "object" && element.options !== null) {
      for (const option of Object.values(element.options as Record<string, unknown>)) {
        if (typeof option === "object" && option !== null) {
          collectPlaceholders((option as { readonly value?: unknown }).value, placeholders, tags);
        }
      }
    }

    collectPlaceholders(element.children, placeholders, tags);
  }
}

function analyzeMessage(locale: Locale, message: string): MessageAnalysis {
  const placeholders = new Set<string>();
  const tags = new Set<string>();
  collectPlaceholders(new IntlMessageFormat(message, locale).getAst(), placeholders, tags);
  return { placeholders, tags };
}

/** The argument names used by an ICU message, across every plural/select branch. */
export function messagePlaceholders(locale: Locale, message: string): ReadonlySet<string> {
  return analyzeMessage(locale, message).placeholders;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateRuntimeMessage(input: {
  readonly locale: Locale;
  readonly key: string;
  readonly message: string;
  readonly baseMessage: string;
}): RuntimeCatalogIssue[] {
  const issues: RuntimeCatalogIssue[] = [];
  let analysis: MessageAnalysis;

  try {
    analysis = analyzeMessage(input.locale, input.message);
  } catch (error) {
    return [
      {
        code: "invalid_icu",
        key: input.key,
        message: `"${input.key}" has invalid ICU syntax: ${errorText(error)}`,
      },
    ];
  }

  if (analysis.tags.size > 0) {
    return [
      {
        code: "unsupported_tag",
        key: input.key,
        message: `"${input.key}" uses rich-text tags (<${[...analysis.tags].sort().join(">, <")}>) which the string formatter cannot render`,
      },
    ];
  }

  let baseAnalysis: MessageAnalysis;

  try {
    baseAnalysis = analyzeMessage(DEFAULT_LOCALE, input.baseMessage);
  } catch (error) {
    return [
      {
        code: "invalid_icu",
        key: input.key,
        message: `"${input.key}" has invalid base ICU syntax: ${errorText(error)}`,
      },
    ];
  }

  if (baseAnalysis.tags.size > 0) {
    return [
      {
        code: "unsupported_tag",
        key: input.key,
        message: `"${input.key}" has unsupported rich-text tags in its base message`,
      },
    ];
  }

  const missing = [...baseAnalysis.placeholders]
    .filter((name) => !analysis.placeholders.has(name))
    .sort();
  const extra = [...analysis.placeholders]
    .filter((name) => !baseAnalysis.placeholders.has(name))
    .sort();

  if (missing.length > 0 || extra.length > 0) {
    const details = [
      ...missing.map((name) => `missing {${name}}`),
      ...extra.map((name) => `unexpected {${name}}`),
    ];

    issues.push({
      code: "placeholder_mismatch",
      key: input.key,
      missingPlaceholders: missing,
      extraPlaceholders: extra,
      message: `"${input.key}" placeholders do not match the base message: ${details.join(", ")}`,
    });
  }

  return issues;
}

export function catalogCompleteness(base: Catalog, candidate: Catalog): CompletenessReport {
  const keys = Object.keys(base).sort();
  const missingKeys = keys.filter((key) => candidate[key] === undefined);
  const totalKeys = keys.length;
  const presentKeys = totalKeys - missingKeys.length;

  return {
    totalKeys,
    presentKeys,
    missingKeys,
    percentage: totalKeys === 0 ? 100 : Math.round((presentKeys / totalKeys) * 100),
  };
}

/**
 * Validates a runtime catalog (admin override, theme or plugin) against its English base.
 * Missing keys are not errors: they fall back to the base language and reduce completeness.
 */
export function validateRuntimeCatalog(input: {
  readonly locale: Locale;
  readonly catalog: Catalog;
  readonly base?: Catalog;
  /** Set for plugin catalogs to enforce their own namespace. */
  readonly pluginId?: string;
}): RuntimeCatalogValidation {
  const base: Catalog = input.base ?? CATALOGS[DEFAULT_LOCALE];
  const issues: RuntimeCatalogIssue[] = [];

  for (const [key, message] of Object.entries(input.catalog).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (input.pluginId !== undefined && !isPluginMessageKey(input.pluginId, key)) {
      issues.push({
        code: "foreign_key",
        key,
        message: `"${key}" is outside the plugin.${input.pluginId} namespace`,
      });
      continue;
    }

    const baseMessage = base[key];

    if (baseMessage === undefined) {
      issues.push({
        code: "unknown_key",
        key,
        message: `"${key}" is not defined in the base catalog`,
      });
      continue;
    }

    issues.push(
      ...validateRuntimeMessage({
        locale: input.locale,
        key,
        message,
        baseMessage,
      }),
    );
  }

  return {
    locale: input.locale,
    issues,
    completeness: catalogCompleteness(base, input.catalog),
  };
}

/**
 * Applies the translation lookup order: admin override, theme override, plugin catalog (with
 * English fallback), shipped catalog, then shipped English.
 */
export function resolveRuntimeMessage(input: RuntimeMessageInput): string | undefined {
  const shipped: Partial<Record<Locale, Catalog>> = input.shipped ?? CATALOGS;
  const plugin =
    input.plugin !== undefined && isPluginMessageKey(input.plugin.id, input.key)
      ? (input.plugin.catalogs[input.locale]?.[input.key] ??
        input.plugin.catalogs[DEFAULT_LOCALE]?.[input.key])
      : undefined;

  return (
    input.overrides?.[input.key] ??
    input.theme?.[input.key] ??
    plugin ??
    shipped[input.locale]?.[input.key] ??
    shipped[DEFAULT_LOCALE]?.[input.key]
  );
}
