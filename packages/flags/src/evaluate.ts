import { type FlagDefinition, type FlagViewer, GUEST_GROUP } from "./types.ts";

/** 100% is 10,000 buckets, so whole percents map exactly onto bucket ranges. */
export const BUCKET_COUNT = 10_000;

/**
 * Stable bucket for a flag and member. The same pair always lands in the same bucket, so
 * raising a rollout percentage only ever adds members (design `feature-flags`).
 */
export function flagBucket(key: string, memberId: string): number {
  return (Bun.hash.xxHash32(`${key}:${memberId}`) >>> 0) % BUCKET_COUNT;
}

/** Rules run in order and the first match wins; no match falls through to the default. */
export function evaluateFlag(definition: FlagDefinition, viewer: FlagViewer): boolean {
  const isGuest = viewer.memberId === null;

  for (const rule of definition.rules) {
    if (rule.type === "group") {
      if (viewer.groups.some((group) => rule.groups.includes(group))) {
        return rule.value;
      }

      continue;
    }

    // ADR 0010: render-affecting flags never roll guests out by percentage, and a guest has
    // no member id to bucket in any case.
    if (isGuest || (definition.affectsRender && viewer.groups.includes(GUEST_GROUP))) {
      continue;
    }

    if (flagBucket(definition.key, viewer.memberId) < rule.percent * 100) {
      return rule.value;
    }
  }

  return definition.defaultValue;
}

/** Every flag's value, keyed by flag key. Used by the template accessor. */
export function evaluateFlags(
  definitions: Iterable<FlagDefinition>,
  viewer: FlagViewer,
): Record<string, boolean> {
  const values: Record<string, boolean> = {};

  for (const definition of definitions) {
    values[definition.key] = evaluateFlag(definition, viewer);
  }

  return values;
}

export function renderFlagValues(
  definitions: Iterable<FlagDefinition>,
  viewer: FlagViewer,
): Record<string, boolean> {
  const values: Record<string, boolean> = {};

  for (const definition of definitions) {
    if (definition.affectsRender) {
      values[definition.key] = evaluateFlag(definition, viewer);
    }
  }

  return values;
}

export function clientFlagValues(
  definitions: Iterable<FlagDefinition>,
  viewer: FlagViewer,
): Record<string, boolean> {
  const values: Record<string, boolean> = {};

  for (const definition of definitions) {
    if (definition.clientVisible) {
      values[definition.key] = evaluateFlag(definition, viewer);
    }
  }

  return values;
}

/**
 * Hash of the evaluated render flags for the cache variant (ADR 0006). Key order is fixed so
 * only a value change, never insertion order, changes the hash.
 */
export function renderFlagsHash(values: Readonly<Record<string, boolean>>): string {
  const canonical = Object.keys(values)
    .sort()
    .map((key) => `${key}=${values[key] === true ? "1" : "0"}`)
    .join("\u0000");

  return Bun.hash.xxHash64(canonical).toString(16);
}
