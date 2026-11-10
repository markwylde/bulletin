import { type FlagDefinition, type FlagRule, isFlagKey } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the `rules` jsonb column. Malformed entries are dropped rather than guessed at:
 * the remaining rules still evaluate, and a flag with no valid rule keeps its default.
 */
export function parseFlagRules(value: unknown): FlagRule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const rules: FlagRule[] = [];

  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.value !== "boolean") {
      continue;
    }

    if (entry.type === "group" && Array.isArray(entry.groups)) {
      const groups = entry.groups.filter(
        (group): group is string => typeof group === "string" && group !== "",
      );

      if (groups.length > 0) {
        rules.push({ type: "group", groups, value: entry.value });
      }

      continue;
    }

    if (
      entry.type === "percentage" &&
      typeof entry.percent === "number" &&
      Number.isInteger(entry.percent) &&
      entry.percent >= 0 &&
      entry.percent <= 100
    ) {
      rules.push({ type: "percentage", percent: entry.percent, value: entry.value });
    }
  }

  return rules;
}

export function isValidFlagDefinition(definition: FlagDefinition): boolean {
  return (
    isFlagKey(definition.key) &&
    definition.description.trim() !== "" &&
    definition.owner.trim() !== ""
  );
}

/** The most rules a single flag may carry; keeps the staff editor and jsonb document bounded. */
export const MAX_FLAG_RULES = 20;

export type FlagRulesParse =
  | { readonly ok: true; readonly rules: readonly FlagRule[] }
  | { readonly ok: false; readonly fields: readonly string[] };

/**
 * Strict validation for staff input. Unlike `parseFlagRules`, which drops bad stored rules,
 * any invalid node rejects the whole submission so staff cannot save a silently smaller list.
 */
export function parseFlagRulesInput(value: unknown): FlagRulesParse {
  if (!Array.isArray(value)) {
    return { ok: false, fields: ["rules"] };
  }

  if (value.length > MAX_FLAG_RULES) {
    return { ok: false, fields: ["rules"] };
  }

  const rules: FlagRule[] = [];
  const fields: string[] = [];

  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry) || typeof entry.value !== "boolean") {
      fields.push(`rule-${index}`);
      continue;
    }

    if (entry.type === "group") {
      const groups = Array.isArray(entry.groups)
        ? entry.groups.filter(
            (group): group is string => typeof group === "string" && group.trim() !== "",
          )
        : [];

      if (groups.length === 0) {
        fields.push(`rule-${index}-groups`);
        continue;
      }

      rules.push({ type: "group", groups, value: entry.value });
      continue;
    }

    if (
      entry.type === "percentage" &&
      typeof entry.percent === "number" &&
      Number.isInteger(entry.percent) &&
      entry.percent >= 0 &&
      entry.percent <= 100
    ) {
      rules.push({ type: "percentage", percent: entry.percent, value: entry.value });
      continue;
    }

    fields.push(`rule-${index}`);
  }

  return fields.length === 0 ? { ok: true, rules } : { ok: false, fields };
}
