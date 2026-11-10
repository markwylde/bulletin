import { describe, expect, test } from "bun:test";
import { type GroupSettingDefinition, settingDefinition } from "@bulletin/domain/permissions";
import { displayedSettingValue, durationUnitKey, parsedSettingValue } from "./settings.ts";

function definition(key: string): GroupSettingDefinition {
  const found = settingDefinition(key);

  if (found === undefined) {
    throw new Error(`Missing setting ${key}`);
  }

  return found;
}

describe("group settings matrix helpers", () => {
  test("an unset setting displays its registry default, including default-true booleans", () => {
    expect(displayedSettingValue(definition("posting.can_react"), undefined)).toBe(true);
    expect(displayedSettingValue(definition("posting.can_react"), false)).toBe(false);
    expect(displayedSettingValue(definition("posting.flood_control_seconds"), undefined)).toBe(
      "15",
    );
  });

  test("duration settings use their registry unit", () => {
    expect(durationUnitKey(definition("posting.edit_window_minutes"))).toBe("staff.groups.minutes");
    expect(durationUnitKey(definition("posting.flood_control_seconds"))).toBe(
      "staff.groups.seconds",
    );
    expect(durationUnitKey(definition("posting.can_react"))).toBeNull();
  });

  test("parses values back to their registry type", () => {
    expect(parsedSettingValue(definition("posting.can_react"), false)).toBe(false);
    expect(parsedSettingValue(definition("posting.flood_control_seconds"), "20")).toBe(20);
    expect(parsedSettingValue(definition("display.name_colour"), "gold")).toBe("gold");
  });
});
