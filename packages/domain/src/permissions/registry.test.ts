import { describe, expect, test } from "bun:test";
import {
  GROUP_SETTINGS,
  type GroupSettingDefinition,
  type GroupSettingsSource,
  isAcpPermissionKey,
  isPermissionKey,
  mergeGroupSettings,
  PERMISSION_KEYS,
  parseGroupSettingValue,
  settingDefinition,
} from "./registry.ts";

function definition(overrides: Partial<GroupSettingDefinition>): GroupSettingDefinition {
  return {
    key: "test.value",
    kind: "setting",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "posting",
    labelKey: "staff.groups.setting.test",
    ...overrides,
  };
}

function source(
  groupId: string,
  isPrimary: boolean,
  values: Readonly<Record<string, unknown>>,
): GroupSettingsSource {
  return { groupId, isPrimary, values };
}

describe("group settings registry", () => {
  test("has a unique key for every entry and legal type/merge combinations", () => {
    const keys = GROUP_SETTINGS.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);

    for (const entry of GROUP_SETTINGS) {
      if (entry.merge === "allow-any" || entry.merge === "restrict-any") {
        expect(entry.type).toBe("bool");
      }

      if (entry.merge === "max" || entry.merge === "min") {
        expect(["int", "duration"]).toContain(entry.type);
      }

      if (entry.type === "enum") {
        expect(entry.values?.length ?? 0).toBeGreaterThan(0);
        expect(entry.values).toContain(entry.defaultValue as string);
      }

      if (entry.kind === "permission") {
        expect(entry.type).toBe("bool");
        expect(entry.defaultValue).toBe(false);
      }

      expect(settingDefinition(entry.key)).toBe(entry);
    }
  });

  test("exposes the ACP permissions migrated from the staff-console shell", () => {
    for (const key of [
      "acp.access",
      "acp.flags",
      "acp.log",
      "acp.members",
      "acp.members.groups",
      "acp.groups",
      "acp.permissions",
      "acp.settings",
      "acp.strings",
      "acp.system",
    ]) {
      expect(isPermissionKey(key)).toBe(true);
      expect(isAcpPermissionKey(key)).toBe(true);
    }

    expect(isAcpPermissionKey("board.view_offline")).toBe(false);
    expect(isPermissionKey("posting.can_react")).toBe(false);
    expect(PERMISSION_KEYS).toContain("sessions.revoke");
    expect(PERMISSION_KEYS).toContain("members.view_name_history");
  });

  test("parses values by type", () => {
    expect(parseGroupSettingValue(definition({ type: "bool" }), true)).toBe(true);
    expect(parseGroupSettingValue(definition({ type: "bool" }), "true")).toBeNull();
    expect(parseGroupSettingValue(definition({ type: "int" }), 12)).toBe(12);
    expect(parseGroupSettingValue(definition({ type: "int" }), 1.5)).toBeNull();
    expect(parseGroupSettingValue(definition({ type: "int" }), -1)).toBeNull();
    expect(parseGroupSettingValue(definition({ type: "duration" }), 30)).toBe(30);
    expect(parseGroupSettingValue(definition({ type: "enum", values: ["a", "b"] }), "b")).toBe("b");
    expect(
      parseGroupSettingValue(definition({ type: "enum", values: ["a", "b"] }), "c"),
    ).toBeNull();
  });
});

describe("merge rules", () => {
  test("allow-any: true when any group grants it", () => {
    const allow = definition({ merge: "allow-any", defaultValue: false });
    const groups = [
      source("1", true, {}),
      source("2", false, { "test.value": false }),
      source("3", false, { "test.value": true }),
    ];

    expect(mergeGroupSettings(groups, [allow])["test.value"]).toBe(true);
  });

  test("allow-any: false when every group that sets it declines", () => {
    const allow = definition({ merge: "allow-any", defaultValue: true });
    const groups = [source("1", true, { "test.value": false })];

    expect(mergeGroupSettings(groups, [allow])["test.value"]).toBe(false);
  });

  test("restrict-any: a restriction wins over the default", () => {
    const restrict = definition({ merge: "restrict-any", defaultValue: false });
    const groups = [source("1", true, {}), source("2", false, { "test.value": true })];

    expect(mergeGroupSettings(groups, [restrict])["test.value"]).toBe(true);
  });

  test("max: the highest quota wins", () => {
    const quota = definition({ type: "int", merge: "max", defaultValue: 0 });
    const groups = [
      source("1", true, { "test.value": 10 }),
      source("2", false, { "test.value": 50 }),
    ];

    expect(mergeGroupSettings(groups, [quota])["test.value"]).toBe(50);
  });

  test("min: the smallest flood window wins", () => {
    const flood = definition({ type: "duration", merge: "min", defaultValue: 15 });
    const groups = [
      source("1", true, { "test.value": 30 }),
      source("2", false, { "test.value": 5 }),
    ];

    expect(mergeGroupSettings(groups, [flood])["test.value"]).toBe(5);
  });

  test("primary: only the primary group's value is used", () => {
    const colour = definition({
      type: "enum",
      merge: "primary",
      defaultValue: "default",
      values: ["default", "gold", "red"],
    });
    const groups = [
      source("1", false, { "test.value": "red" }),
      source("2", true, { "test.value": "gold" }),
    ];

    expect(mergeGroupSettings(groups, [colour])["test.value"]).toBe("gold");

    expect(
      mergeGroupSettings(
        [source("1", true, {}), source("2", false, { "test.value": "red" })],
        [colour],
      )["test.value"],
    ).toBe("default");
  });

  test("falls back to the default when no group sets a value", () => {
    const quota = definition({ type: "int", merge: "max", defaultValue: 7 });

    expect(mergeGroupSettings([source("1", true, {})], [quota])["test.value"]).toBe(7);
    expect(mergeGroupSettings([], [quota])["test.value"]).toBe(7);
  });

  test("ignores stored values of the wrong type so they cannot grant anything", () => {
    const allow = definition({ merge: "allow-any", defaultValue: false });
    const quota = definition({ type: "int", merge: "max", defaultValue: 3 });
    const groups = [
      source("1", true, { "test.allow": "yes", "test.quota": "lots" }),
      source("2", false, { "test.allow": 1, "test.quota": 99 }),
    ];

    const merged = mergeGroupSettings(groups, [
      { ...allow, key: "test.allow" },
      { ...quota, key: "test.quota" },
    ]);

    expect(merged["test.allow"]).toBe(false);
    expect(merged["test.quota"]).toBe(99);
  });

  test("merges every registered setting to a value", () => {
    const merged = mergeGroupSettings([
      source("1", true, {
        "display.name_colour": "gold",
        "posting.upload_quota_mb": 50,
      }),
      source("2", false, {
        "posting.upload_quota_mb": 10,
        "posting.posts_require_approval": true,
      }),
    ]);

    expect(Object.keys(merged).sort()).toEqual(GROUP_SETTINGS.map((entry) => entry.key).sort());
    expect(merged["display.name_colour"]).toBe("gold");
    expect(merged["posting.upload_quota_mb"]).toBe(50);
    expect(merged["posting.posts_require_approval"]).toBe(true);
  });
});
