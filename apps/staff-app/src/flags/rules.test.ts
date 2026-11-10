import { describe, expect, test } from "bun:test";
import type { FlagRule } from "@bulletin/flags/client";
import { createServerT } from "@bulletin/i18n";
import en from "../../i18n/en.json";
import {
  describeChange,
  describeRules,
  draftFromRules,
  FLAG_GROUP_OPTIONS,
  groupFieldId,
  percentFieldId,
  ruleFormDefinition,
  rulesFromValues,
  valueFieldId,
} from "./rules.ts";

const t = createServerT("en", { overrides: en });

const RULES: readonly FlagRule[] = [
  { type: "group", groups: ["super_moderators", "administrators"], value: true },
  { type: "percentage", percent: 50, value: false },
];

describe("flag rule editor", () => {
  test("round-trips rules through the form values in order", () => {
    const draft = draftFromRules(RULES);

    expect(draft.rules).toEqual([
      { id: 0, type: "group" },
      { id: 1, type: "percentage" },
    ]);
    expect(draft.values[groupFieldId(0)]).toEqual(["super_moderators", "administrators"]);
    expect(draft.values[valueFieldId(0)]).toBe(true);
    expect(draft.values[percentFieldId(1)]).toBe(50);
    expect(draft.values[valueFieldId(1)]).toBe(false);
    expect(rulesFromValues(draft.rules, draft.values)).toEqual([...RULES]);
  });

  test("builds one form section per rule in the edited order", () => {
    const definition = ruleFormDefinition(draftFromRules(RULES).rules);

    expect(definition.id).toBe("flag-rules");
    expect(definition.submitLabelKey).toBe("staff.flags.saveRules");
    expect(definition.sections.map((section) => section.id)).toEqual(["rule-0", "rule-1"]);
    expect(definition.sections.map((section) => section.titleKey)).toEqual([
      "staff.flags.rule.group",
      "staff.flags.rule.percentage",
    ]);
    expect(definition.sections[0]?.fields.map((field) => field.id)).toEqual([
      groupFieldId(0),
      valueFieldId(0),
    ]);
    expect(definition.sections[1]?.fields.map((field) => field.id)).toEqual([
      percentFieldId(1),
      valueFieldId(1),
    ]);
    expect(FLAG_GROUP_OPTIONS.map((option) => option.value)).toContain("guests");
  });

  test("describes rules with translated group names and percentages", () => {
    expect(describeRules(t, RULES)).toBe(
      "On for Super moderators, Administrators · Off for 50% of members",
    );
    expect(describeRules(t, [])).toBe("No rules");
    expect(describeRules(t, [{ type: "group", groups: ["custom_group"], value: false }])).toBe(
      "Off for custom_group",
    );
  });

  test("summarises an admin log entry with the rules after the change", () => {
    expect(
      describeChange(t, {
        key: "newEditor",
        before: { rules: [] },
        after: { rules: [{ type: "percentage", percent: 20, value: true }] },
      }),
    ).toBe("newEditor: On for 20% of members");
    expect(describeChange(t, "not a summary")).toBeNull();
  });
});
