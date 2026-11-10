import type { GroupSettingDefinition } from "@bulletin/domain/permissions";

/** The value shown in a matrix cell, using the registry default when no group value exists. */
export function displayedSettingValue(
  definition: GroupSettingDefinition,
  value: unknown,
): string | boolean {
  const raw = value === undefined ? definition.defaultValue : value;

  if (definition.type === "bool") {
    return raw === true;
  }

  if (typeof raw === "number" || typeof raw === "string") {
    return String(raw);
  }

  return String(definition.defaultValue);
}

export function parsedSettingValue(
  definition: GroupSettingDefinition,
  raw: string | boolean,
): boolean | number | string {
  if (definition.type === "bool") {
    return raw === true;
  }

  if (definition.type === "int" || definition.type === "duration") {
    return Number(raw);
  }

  return String(raw);
}

const DURATION_UNIT_LABELS = {
  seconds: { labelKey: "staff.groups.seconds" },
  minutes: { labelKey: "staff.groups.minutes" },
} as const;

/** Duration settings carry their display unit in the registry (minutes vs seconds). */
export function durationUnitKey(definition: GroupSettingDefinition): string | null {
  if (definition.type !== "duration") {
    return null;
  }

  return DURATION_UNIT_LABELS[definition.unit ?? "seconds"].labelKey;
}
