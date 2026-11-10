import * as v from "valibot";

/**
 * Island props schemas (ADR 0008): every island in the fixed registry validates untrusted
 * template props against one of these before it renders or hydrates.
 */
export type IslandPropsSchema<TProps extends object = object> = v.BaseSchema<
  unknown,
  TProps,
  v.BaseIssue<unknown>
>;

export const LOCALE_VALUES = ["en", "es", "fr"] as const;

const languageOptionSchema = v.strictObject({
  value: v.picklist(LOCALE_VALUES),
  label: v.pipe(v.string(), v.minLength(1)),
});

export const spikeCounterSchema = v.strictObject({
  label: v.pipe(v.string(), v.trim(), v.minLength(1)),
  start: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
});

export const languageSwitcherSchema = v.strictObject({
  current: v.picklist(LOCALE_VALUES),
  options: v.pipe(v.array(languageOptionSchema), v.minLength(1)),
  label: v.pipe(v.string(), v.minLength(1)),
  nameRequired: v.pipe(v.string(), v.minLength(1)),
  saveFailed: v.pipe(v.string(), v.minLength(1)),
});

export const localeSuggestionSchema = v.strictObject({
  current: v.picklist(LOCALE_VALUES),
  options: v.pipe(v.array(languageOptionSchema), v.minLength(1)),
  message: v.pipe(v.string(), v.minLength(1)),
  accept: v.pipe(v.string(), v.minLength(1)),
  dismiss: v.pipe(v.string(), v.minLength(1)),
});

/** The canonical island names; the template registry and the client runtime must match. */
export const ISLAND_SCHEMAS = {
  SpikeCounter: spikeCounterSchema,
  LanguageSwitcher: languageSwitcherSchema,
  LocaleSuggestion: localeSuggestionSchema,
} as const;

export type IslandName = keyof typeof ISLAND_SCHEMAS;

export const ISLAND_NAMES: readonly IslandName[] = Object.keys(ISLAND_SCHEMAS) as IslandName[];
