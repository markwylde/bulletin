import { BUCKET_COUNT, evaluateFlagWithBucket } from "./evaluate.ts";
import { type FlagDefinition, type FlagViewer, GUEST_VIEWER } from "./types.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A flag that has been fully on for this long is ready for removal (ADR 0010: flag cleanup
 * is part of a feature's definition of done).
 */
export const STALE_FLAG_DAYS = 90;

export const STALE_FLAG_MS = STALE_FLAG_DAYS * DAY_MS;

/**
 * Every group that can win the ordered group-rule walk: a group is covered by the first rule
 * that lists it, so only groups not seen in an earlier rule need their own viewer. The final
 * set matches no group rule, which exercises the default and the percentage rules alone.
 */
function representativeGroupSets(definition: FlagDefinition): string[][] {
  const sets: string[][] = [];
  const covered = new Set<string>();

  for (const rule of definition.rules) {
    if (rule.type !== "group") {
      continue;
    }

    for (const group of rule.groups) {
      if (covered.has(group)) {
        continue;
      }

      sets.push([group]);
      covered.add(group);
    }
  }

  sets.push([unmatchedGroup(covered)]);
  return sets;
}

function unmatchedGroup(covered: ReadonlySet<string>): string {
  let group = "unmatched";

  while (covered.has(group)) {
    group = `${group}x`;
  }

  return group;
}

/**
 * Buckets covering every percentage outcome. A rule only compares the bucket with
 * `percent * 100`, so each threshold and the bucket just below it are the only boundaries.
 */
function representativeBuckets(definition: FlagDefinition): number[] {
  const buckets = new Set<number>([0, BUCKET_COUNT - 1]);

  for (const rule of definition.rules) {
    if (rule.type !== "percentage") {
      continue;
    }

    const threshold = rule.percent * 100;

    if (threshold > 0) {
      buckets.add(threshold - 1);
    }

    if (threshold < BUCKET_COUNT) {
      buckets.add(threshold);
    }
  }

  return [...buckets];
}

/**
 * True when no viewer can evaluate the flag to `false`, decided with the real evaluation
 * semantics: guests, one viewer per group class, and every bucket boundary. Percentage rules
 * never target guests, so the guest walk only depends on group rules and the default.
 */
export function isFullyOn(definition: FlagDefinition): boolean {
  if (!evaluateFlagWithBucket(definition, GUEST_VIEWER, 0)) {
    return false;
  }

  const buckets = representativeBuckets(definition);

  for (const groups of representativeGroupSets(definition)) {
    const viewer: FlagViewer = { memberId: "1", groups };

    for (const bucket of buckets) {
      if (!evaluateFlagWithBucket(definition, viewer, bucket)) {
        return false;
      }
    }
  }

  return true;
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
