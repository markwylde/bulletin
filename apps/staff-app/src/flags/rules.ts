import { type FlagRule, parseFlagRules } from "@bulletin/flags/client";
import type { Translator } from "@bulletin/i18n";
import type {
  FormDefinition,
  FormField,
  FormOption,
  FormValue,
  FormValues,
} from "@bulletin/ui/forms";

export type DraftRuleType = "group" | "percentage";

/** A rule being edited; the id keeps its form fields stable while rules move or disappear. */
export interface DraftRule {
  readonly id: number;
  readonly type: DraftRuleType;
}

export interface DraftRules {
  readonly rules: readonly DraftRule[];
  readonly values: FormValues;
}

/**
 * The interim system groups from migration 0008. `groups-permissions` replaces this fixed list
 * with the typed group registry; unknown stored keys fall back to their raw key in summaries.
 */
export const FLAG_GROUP_OPTIONS: readonly FormOption[] = [
  { value: "guests", labelKey: "staff.flags.group.guests" },
  { value: "members", labelKey: "staff.flags.group.members" },
  { value: "super_moderators", labelKey: "staff.flags.group.superModerators" },
  { value: "administrators", labelKey: "staff.flags.group.administrators" },
  { value: "banned", labelKey: "staff.flags.group.banned" },
];

const SECTION_TITLES = {
  group: { titleKey: "staff.flags.rule.group" },
  percentage: { titleKey: "staff.flags.rule.percentage" },
} as const;

export function groupFieldId(id: number): string {
  return `rule-${id}-groups`;
}

export function percentFieldId(id: number): string {
  return `rule-${id}-percent`;
}

export function valueFieldId(id: number): string {
  return `rule-${id}-value`;
}

function ruleFields(rule: DraftRule): readonly FormField[] {
  const value: FormField = {
    id: valueFieldId(rule.id),
    type: "toggle",
    labelKey: "staff.flags.rule.on",
    helpKey: "staff.flags.rule.onHelp",
  };

  if (rule.type === "group") {
    return [
      {
        id: groupFieldId(rule.id),
        type: "group-picker",
        labelKey: "staff.flags.rule.groups",
        helpKey: "staff.flags.rule.groupsHelp",
        options: FLAG_GROUP_OPTIONS,
        minItems: 1,
      },
      value,
    ];
  }

  return [
    {
      id: percentFieldId(rule.id),
      type: "number",
      labelKey: "staff.flags.rule.percent",
      helpKey: "staff.flags.rule.percentHelp",
      required: true,
      min: 0,
      max: 100,
      step: 1,
    },
    value,
  ];
}

/** Builds the whole ordered rule list as one form, so the shared renderer does validation. */
export function ruleFormDefinition(rules: readonly DraftRule[]): FormDefinition {
  return {
    id: "flag-rules",
    submitLabelKey: "staff.flags.saveRules",
    sections: rules.map((rule) => ({
      id: `rule-${rule.id}`,
      titleKey: SECTION_TITLES[rule.type].titleKey,
      fields: ruleFields(rule),
    })),
  };
}

export function draftFromRules(rules: readonly FlagRule[]): DraftRules {
  const drafts = rules.map((rule, index) => ({ id: index, type: rule.type }));
  const values: Record<string, FormValue | undefined> = {};

  drafts.forEach((draft, index) => {
    const rule = rules[index];

    if (rule === undefined) {
      return;
    }

    if (rule.type === "group") {
      values[groupFieldId(draft.id)] = rule.groups;
    } else {
      values[percentFieldId(draft.id)] = rule.percent;
    }

    values[valueFieldId(draft.id)] = rule.value;
  });

  return { rules: drafts, values };
}

/** Reads the submitted form back into ordered rules; the renderer blocks invalid submissions. */
export function rulesFromValues(drafts: readonly DraftRule[], values: FormValues): FlagRule[] {
  return drafts.map((draft) => {
    const value = values[valueFieldId(draft.id)] === true;

    if (draft.type === "group") {
      const groups = values[groupFieldId(draft.id)];
      return { type: "group", groups: Array.isArray(groups) ? groups : [], value };
    }

    const percent = values[percentFieldId(draft.id)];
    return {
      type: "percentage",
      percent: typeof percent === "number" ? Math.trunc(percent) : 0,
      value,
    };
  });
}

function groupLabel(t: Translator, key: string): string {
  switch (key) {
    case "guests":
      return t("staff.flags.group.guests");
    case "members":
      return t("staff.flags.group.members");
    case "super_moderators":
      return t("staff.flags.group.superModerators");
    case "administrators":
      return t("staff.flags.group.administrators");
    case "banned":
      return t("staff.flags.group.banned");
    default:
      return key;
  }
}

export function describeRule(t: Translator, rule: FlagRule): string {
  if (rule.type === "group") {
    const groups = rule.groups.map((group) => groupLabel(t, group)).join(", ");

    return rule.value
      ? t("staff.flags.summary.groupOn", { groups })
      : t("staff.flags.summary.groupOff", { groups });
  }

  return rule.value
    ? t("staff.flags.summary.percentOn", { percent: rule.percent })
    : t("staff.flags.summary.percentOff", { percent: rule.percent });
}

export function describeRules(t: Translator, rules: readonly FlagRule[]): string {
  return rules.length === 0
    ? t("staff.flags.rules.none")
    : rules.map((rule) => describeRule(t, rule)).join(" · ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One admin log line: the flag key and the rules it ended up with. */
export function describeChange(t: Translator, summary: unknown): string | null {
  if (!isRecord(summary) || typeof summary.key !== "string") {
    return null;
  }

  const after = isRecord(summary.after) ? parseFlagRules(summary.after.rules) : [];

  return t("staff.flags.log.change", {
    key: summary.key,
    rules: describeRules(t, after),
  });
}
