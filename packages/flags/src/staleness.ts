import type { FlagDefinition } from "./types.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A flag that has been fully on for this long is ready for removal (ADR 0010: flag cleanup
 * is part of a feature's definition of done).
 */
export const STALE_FLAG_DAYS = 90;

export const STALE_FLAG_MS = STALE_FLAG_DAYS * DAY_MS;

/**
 * True when no viewer can evaluate the flag to `false`: the default is on and every rule
 * turns it on at full strength. Percentage rules below 100 leave part of the membership off.
 */
export function isFullyOn(definition: FlagDefinition): boolean {
  if (!definition.defaultValue) {
    return false;
  }

  return definition.rules.every(
    (rule) => rule.value && (rule.type === "group" || rule.percent >= 100),
  );
}

/** Whole days since the flag first appeared in the staff app. */
export function flagAgeDays(createdAt: Date, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - createdAt.getTime()) / DAY_MS));
}

/**
 * Only `updated_at` is stored, so "100% on for over 90 days" is measured from the last rule
 * change: a flag that is fully on and has not been touched for 90 days is ready for removal.
 */
export function isStaleFlag(
  definition: FlagDefinition,
  updatedAt: Date,
  now: number = Date.now(),
): boolean {
  return isFullyOn(definition) && now - updatedAt.getTime() >= STALE_FLAG_MS;
}
