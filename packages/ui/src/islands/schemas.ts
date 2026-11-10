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

export const spikeCounterSchema = v.strictObject({
  label: v.pipe(v.string(), v.trim(), v.minLength(1)),
  start: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
});

/** The canonical island names; the template registry and the client runtime must match. */
export const ISLAND_SCHEMAS = {
  SpikeCounter: spikeCounterSchema,
} as const;

export type IslandName = keyof typeof ISLAND_SCHEMAS;

export const ISLAND_NAMES: readonly IslandName[] = Object.keys(ISLAND_SCHEMAS) as IslandName[];
