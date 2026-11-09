import { IntlMessageFormat } from "intl-messageformat";
import { CATALOGS, type Catalog, DEFAULT_LOCALE, type Locale } from "./catalog.ts";

export interface CompletenessReport {
  readonly totalKeys: number;
  readonly presentKeys: number;
  readonly missingKeys: readonly string[];
  readonly percentage: number;
}

export type RuntimeCatalogIssueCode = "invalid_icu" | "placeholder_mismatch" | "unknown_key";

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

export interface RuntimeMessageInput {
  readonly key: string;
  readonly locale: Locale;
  readonly overrides?: Catalog;
  readonly theme?: Catalog;
  readonly plugin?: Partial<Record<Locale, Catalog>>;
  readonly shipped?: Partial<Record<Locale, Catalog>>;
}

const LITERAL_TYPE = 0;
const POUND_TYPE = 7;

function collectPlaceholders(nodes: unknown, found: Set<string>): void {
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

    if (
      typeof element.type === "number" &&
      element.type !== LITERAL_TYPE &&
      element.type !== POUND_TYPE &&
      typeof element.value === "string"
    ) {
      found.add(element.value);
    }

    if (typeof element.options === "object" && element.options !== null) {
      for (const option of Object.values(element.options as Record<string, unknown>)) {
        if (typeof option === "object" && option !== null) {
          collectPlaceholders((option as { readonly value?: unknown }).value, found);
        }
      }
    }

    collectPlaceholders(element.children, found);
  }
}

/** The argument names used by an ICU message, across every plural/select branch. */
export function messagePlaceholders(locale: Locale, message: string): ReadonlySet<string> {
  const found = new Set<string>();
  collectPlaceholders(new IntlMessageFormat(message, locale).getAst(), found);
  return found;
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
  let placeholders: ReadonlySet<string>;

  try {
    placeholders = messagePlaceholders(input.locale, input.message);
  } catch (error) {
    return [
      {
        code: "invalid_icu",
        key: input.key,
        message: `"${input.key}" has invalid ICU syntax: ${errorText(error)}`,
      },
    ];
  }

  let basePlaceholders: ReadonlySet<string>;

  try {
    basePlaceholders = messagePlaceholders(DEFAULT_LOCALE, input.baseMessage);
  } catch (error) {
    return [
      {
        code: "invalid_icu",
        key: input.key,
        message: `"${input.key}" has invalid base ICU syntax: ${errorText(error)}`,
      },
    ];
  }

  const missing = [...basePlaceholders].filter((name) => !placeholders.has(name)).sort();
  const extra = [...placeholders].filter((name) => !basePlaceholders.has(name)).sort();

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
}): RuntimeCatalogValidation {
  const base: Catalog = input.base ?? CATALOGS[DEFAULT_LOCALE];
  const issues: RuntimeCatalogIssue[] = [];

  for (const [key, message] of Object.entries(input.catalog).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
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

  return (
    input.overrides?.[input.key] ??
    input.theme?.[input.key] ??
    input.plugin?.[input.locale]?.[input.key] ??
    input.plugin?.[DEFAULT_LOCALE]?.[input.key] ??
    shipped[input.locale]?.[input.key] ??
    shipped[DEFAULT_LOCALE]?.[input.key]
  );
}
