import { MODERATOR_POWERS, moderatorSettingKey } from "./actions.ts";

/**
 * The typed group-settings registry (ADR 0005). Every setting declares its type, merge rule,
 * default, i18n label and ACP section. Plugins append `plugin.<id>.*` entries at load time
 * (change `plugin-platform`); nothing else may bypass this registry.
 */
export const GROUP_SETTING_TYPES = ["bool", "int", "enum", "duration"] as const;

export type GroupSettingType = (typeof GROUP_SETTING_TYPES)[number];

export const MERGE_RULES = ["allow-any", "restrict-any", "max", "min", "primary"] as const;

export type MergeRule = (typeof MERGE_RULES)[number];

export const REGISTRY_SECTIONS = [
  "acp",
  "board",
  "posting",
  "members",
  "moderation",
  "display",
  "restrictions",
] as const;

export type RegistrySection = (typeof REGISTRY_SECTIONS)[number];

export type GroupSettingValue = boolean | number | string;

export interface GroupSettingDefinition {
  readonly key: string;
  /** A permission grant or a value setting. Both are stored in `core.group_settings`. */
  readonly kind: "permission" | "setting";
  readonly type: GroupSettingType;
  readonly merge: MergeRule;
  readonly defaultValue: GroupSettingValue;
  readonly section: RegistrySection;
  /** Message key in the staff-app catalogs (ADR 0013). */
  readonly labelKey: string;
  /** Allowed values for `enum` settings. */
  readonly values?: readonly string[];
  /** Display unit for `duration` settings. */
  readonly unit?: "seconds" | "minutes";
}

const SECTION_LABELS = [
  { section: "acp", labelKey: "staff.groups.section.acp" },
  { section: "board", labelKey: "staff.groups.section.board" },
  { section: "posting", labelKey: "staff.groups.section.posting" },
  { section: "members", labelKey: "staff.groups.section.members" },
  { section: "moderation", labelKey: "staff.groups.section.moderation" },
  { section: "display", labelKey: "staff.groups.section.display" },
  { section: "restrictions", labelKey: "staff.groups.section.restrictions" },
] as const satisfies readonly { section: RegistrySection; labelKey: string }[];

export const SECTION_LABEL_KEYS: Readonly<Record<RegistrySection, string>> = Object.fromEntries(
  SECTION_LABELS.map((entry) => [entry.section, entry.labelKey]),
) as Readonly<Record<RegistrySection, string>>;

const PERMISSION_DEFINITIONS = [
  {
    key: "acp.access",
    kind: "permission",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "acp",
    labelKey: "staff.groups.permission.acpAccess",
  },
  {
    key: "acp.flags",
    kind: "permission",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "acp",
    labelKey: "staff.groups.permission.acpFlags",
  },
  {
    key: "acp.log",
    kind: "permission",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "acp",
    labelKey: "staff.groups.permission.acpLog",
  },
  {
    key: "acp.forums",
    kind: "permission",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "acp",
    labelKey: "staff.groups.permission.acpForums",
  },
  {
    key: "acp.announcements",
    kind: "permission",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "acp",
    labelKey: "staff.groups.permission.acpAnnouncements",
  },
  {
    key: "acp.members",
    kind: "permission",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "acp",
    labelKey: "staff.groups.permission.acpMembers",
  },
  {
    key: "acp.members.groups",
    kind: "permission",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "acp",
    labelKey: "staff.groups.permission.acpMembersGroups",
  },
  {
    key: "members.edit",
    kind: "permission",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "members",
    labelKey: "staff.groups.permission.membersEdit",
  },
  {
    key: "acp.groups",
    kind: "permission",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "acp",
    labelKey: "staff.groups.permission.acpGroups",
  },
  {
    key: "acp.permissions",
    kind: "permission",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "acp",
    labelKey: "staff.groups.permission.acpPermissions",
  },
  {
    key: "acp.settings",
    kind: "permission",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "acp",
    labelKey: "staff.groups.permission.acpSettings",
  },
  {
    key: "acp.emoticons",
    kind: "permission",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "acp",
    labelKey: "staff.groups.permission.acpEmoticons",
  },
  {
    key: "acp.strings",
    kind: "permission",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "acp",
    labelKey: "staff.groups.permission.acpStrings",
  },
  {
    key: "acp.system",
    kind: "permission",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "acp",
    labelKey: "staff.groups.permission.acpSystem",
  },
  {
    key: "board.view_offline",
    kind: "permission",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "board",
    labelKey: "staff.groups.permission.boardViewOffline",
  },
  {
    key: "members.view_name_history",
    kind: "permission",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "members",
    labelKey: "staff.groups.permission.membersViewNameHistory",
  },
  {
    key: "sessions.revoke",
    kind: "permission",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "members",
    labelKey: "staff.groups.permission.sessionsRevoke",
  },
] as const satisfies readonly GroupSettingDefinition[];

export type PermissionKey = (typeof PERMISSION_DEFINITIONS)[number]["key"];

export type AcpPermission = Extract<PermissionKey, `acp.${string}`>;

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_DEFINITIONS.map(
  (definition) => definition.key,
);

const MODERATOR_POWER_LABELS = [
  { power: "edit", labelKey: "staff.groups.power.edit" },
  { power: "soft_delete", labelKey: "staff.groups.power.softDelete" },
  { power: "hard_delete", labelKey: "staff.groups.power.hardDelete" },
  { power: "restore", labelKey: "staff.groups.power.restore" },
  { power: "move", labelKey: "staff.groups.power.move" },
  { power: "merge", labelKey: "staff.groups.power.merge" },
  { power: "split", labelKey: "staff.groups.power.split" },
  { power: "pin", labelKey: "staff.groups.power.pin" },
  { power: "lock", labelKey: "staff.groups.power.lock" },
  { power: "approve", labelKey: "staff.groups.power.approve" },
  { power: "see_unapproved", labelKey: "staff.groups.power.seeUnapproved" },
  { power: "see_deleted", labelKey: "staff.groups.power.seeDeleted" },
  { power: "view_ips", labelKey: "staff.groups.power.viewIps" },
  { power: "warn", labelKey: "staff.groups.power.warn" },
  { power: "view_edit_history", labelKey: "staff.groups.power.viewEditHistory" },
  { power: "use_multimod", labelKey: "staff.groups.power.useMultimod" },
] as const satisfies readonly { power: (typeof MODERATOR_POWERS)[number]; labelKey: string }[];

const MODERATOR_POWER_LABEL_KEYS: Readonly<Record<(typeof MODERATOR_POWERS)[number], string>> =
  Object.fromEntries(
    MODERATOR_POWER_LABELS.map((entry) => [entry.power, entry.labelKey]),
  ) as Readonly<Record<(typeof MODERATOR_POWERS)[number], string>>;

const MODERATOR_SETTING_DEFINITIONS: readonly GroupSettingDefinition[] = MODERATOR_POWERS.map(
  (power) => ({
    key: moderatorSettingKey(power),
    kind: "setting",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "moderation",
    labelKey: MODERATOR_POWER_LABEL_KEYS[power],
  }),
);

const VALUE_SETTING_DEFINITIONS = [
  {
    key: "display.name_colour",
    kind: "setting",
    type: "enum",
    merge: "primary",
    defaultValue: "default",
    section: "display",
    labelKey: "staff.groups.setting.nameColour",
    values: ["default", "blue", "green", "gold", "red", "purple"],
  },
  {
    key: "posting.edit_window_minutes",
    kind: "setting",
    type: "duration",
    merge: "max",
    defaultValue: 0,
    section: "posting",
    unit: "minutes",
    labelKey: "staff.groups.setting.editWindowMinutes",
  },
  {
    key: "posting.flood_control_seconds",
    kind: "setting",
    type: "duration",
    merge: "min",
    defaultValue: 15,
    section: "posting",
    unit: "seconds",
    labelKey: "staff.groups.setting.floodControlSeconds",
  },
  {
    key: "posting.can_delete_own",
    kind: "setting",
    type: "bool",
    merge: "allow-any",
    defaultValue: true,
    section: "posting",
    labelKey: "staff.groups.setting.canDeleteOwn",
  },
  {
    key: "posting.can_react",
    kind: "setting",
    type: "bool",
    merge: "allow-any",
    defaultValue: true,
    section: "posting",
    labelKey: "staff.groups.setting.canReact",
  },
  {
    key: "posting.can_give_reputation",
    kind: "setting",
    type: "bool",
    merge: "allow-any",
    defaultValue: true,
    section: "posting",
    labelKey: "staff.groups.setting.canGiveReputation",
  },
  {
    key: "posting.can_vote",
    kind: "setting",
    type: "bool",
    merge: "allow-any",
    defaultValue: true,
    section: "posting",
    labelKey: "staff.groups.setting.canVote",
  },
  {
    key: "posting.posts_require_approval",
    kind: "setting",
    type: "bool",
    merge: "restrict-any",
    defaultValue: false,
    section: "posting",
    labelKey: "staff.groups.setting.postsRequireApproval",
  },
  {
    key: "posting.queue_first_posts",
    kind: "setting",
    type: "int",
    merge: "max",
    defaultValue: 0,
    section: "posting",
    labelKey: "staff.groups.setting.queueFirstPosts",
  },
  {
    key: "posting.link_limit",
    kind: "setting",
    type: "int",
    merge: "max",
    defaultValue: 0,
    section: "posting",
    labelKey: "staff.groups.setting.linkLimit",
  },
  {
    key: "posting.upload_quota_mb",
    kind: "setting",
    type: "int",
    merge: "max",
    defaultValue: 0,
    section: "posting",
    labelKey: "staff.groups.setting.uploadQuotaMb",
  },
  {
    key: "posting.upload_per_file_kb",
    kind: "setting",
    type: "int",
    merge: "max",
    defaultValue: 0,
    section: "posting",
    labelKey: "staff.groups.setting.uploadPerFileKb",
  },
  {
    key: "posting.upload_images",
    kind: "setting",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "posting",
    labelKey: "staff.groups.setting.uploadImages",
  },
  {
    key: "posting.upload_documents",
    kind: "setting",
    type: "bool",
    merge: "allow-any",
    defaultValue: false,
    section: "posting",
    labelKey: "staff.groups.setting.uploadDocuments",
  },
  {
    key: "posting.pm_quota",
    kind: "setting",
    type: "int",
    merge: "max",
    defaultValue: 0,
    section: "posting",
    labelKey: "staff.groups.setting.pmQuota",
  },
  {
    key: "posting.pm_recipients",
    kind: "setting",
    type: "int",
    merge: "max",
    defaultValue: 1,
    section: "posting",
    labelKey: "staff.groups.setting.pmRecipients",
  },
  {
    key: "members.display_name_changes",
    kind: "setting",
    type: "int",
    merge: "max",
    defaultValue: 1,
    section: "members",
    labelKey: "staff.groups.setting.displayNameChanges",
  },
  {
    key: "members.signature_max_chars",
    kind: "setting",
    type: "int",
    merge: "max",
    defaultValue: 0,
    section: "members",
    labelKey: "staff.groups.setting.signatureMaxChars",
  },
  {
    key: "members.avatar_max_kb",
    kind: "setting",
    type: "int",
    merge: "max",
    defaultValue: 0,
    section: "members",
    labelKey: "staff.groups.setting.avatarMaxKb",
  },
  {
    key: "members.search_flood_seconds",
    kind: "setting",
    type: "duration",
    merge: "min",
    defaultValue: 5,
    section: "members",
    unit: "seconds",
    labelKey: "staff.groups.setting.searchFloodSeconds",
  },
  {
    key: "members.can_choose_theme",
    kind: "setting",
    type: "bool",
    merge: "allow-any",
    defaultValue: true,
    section: "members",
    labelKey: "staff.groups.setting.canChooseTheme",
  },
  {
    key: "restrictions.banned",
    kind: "setting",
    type: "bool",
    merge: "restrict-any",
    defaultValue: false,
    section: "restrictions",
    labelKey: "staff.groups.setting.banned",
  },
  {
    key: "restrictions.cannot_pm",
    kind: "setting",
    type: "bool",
    merge: "restrict-any",
    defaultValue: false,
    section: "restrictions",
    labelKey: "staff.groups.setting.cannotPm",
  },
] as const satisfies readonly GroupSettingDefinition[];

/** Every registry entry, permissions first so the staff matrix lists them consistently. */
export const GROUP_SETTINGS: readonly GroupSettingDefinition[] = [
  ...PERMISSION_DEFINITIONS,
  ...MODERATOR_SETTING_DEFINITIONS,
  ...VALUE_SETTING_DEFINITIONS,
];

export type GroupSettingKey = string;

const DEFINITIONS_BY_KEY = new Map(
  GROUP_SETTINGS.map((definition) => [definition.key, definition]),
);

export function settingDefinition(key: string): GroupSettingDefinition | undefined {
  return DEFINITIONS_BY_KEY.get(key);
}

export function definitionsForSection(section: RegistrySection): readonly GroupSettingDefinition[] {
  return GROUP_SETTINGS.filter((definition) => definition.section === section);
}

export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(value);
}

export function isAcpPermissionKey(value: string): value is AcpPermission {
  return value.startsWith("acp.") && isPermissionKey(value);
}

/** Validates a raw JSON value against a definition. Returns `null` when the type is wrong. */
export function parseGroupSettingValue(
  definition: GroupSettingDefinition,
  value: unknown,
): GroupSettingValue | null {
  switch (definition.type) {
    case "bool":
      return typeof value === "boolean" ? value : null;
    case "int":
    case "duration":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    case "enum":
      return typeof value === "string" && (definition.values ?? []).includes(value) ? value : null;
  }
}

export interface GroupSettingsSource {
  readonly groupId: string;
  readonly isPrimary: boolean;
  /** Raw values keyed by setting key; keys the group does not set are absent. */
  readonly values: Readonly<Record<string, unknown>>;
}

export type MergedGroupSettings = Readonly<Record<string, GroupSettingValue>>;

/** A group's effective value: its explicit setting, otherwise the registry default. */
function groupValue(
  definition: GroupSettingDefinition,
  group: GroupSettingsSource,
): GroupSettingValue {
  const raw = Object.hasOwn(group.values, definition.key)
    ? group.values[definition.key]
    : definition.defaultValue;

  return parseGroupSettingValue(definition, raw) ?? definition.defaultValue;
}

function numericValues(
  definition: GroupSettingDefinition,
  groups: readonly GroupSettingsSource[],
): readonly number[] {
  return groups
    .map((group) => groupValue(definition, group))
    .filter((value): value is number => typeof value === "number");
}

function booleanGranted(
  definition: GroupSettingDefinition,
  groups: readonly GroupSettingsSource[],
): boolean | null {
  if (groups.length === 0) {
    return null;
  }

  return groups.some((group) => groupValue(definition, group) === true);
}

/**
 * Applies every merge rule across a member's groups (ADR 0005). Every group participates with
 * its own effective value: an unset setting means that group's registry default. Restriction
 * and allowance rules both answer "did any group grant it"; they differ in meaning and default.
 * Invalid stored values fall back to the default, so a broken row cannot grant a capability
 * beyond what that group's default allows.
 */
export function mergeGroupSettings(
  groups: readonly GroupSettingsSource[],
  definitions: readonly GroupSettingDefinition[] = GROUP_SETTINGS,
): MergedGroupSettings {
  const merged: Record<string, GroupSettingValue> = {};
  const primary = groups.find((group) => group.isPrimary);

  for (const definition of definitions) {
    switch (definition.merge) {
      case "primary": {
        merged[definition.key] =
          primary === undefined ? definition.defaultValue : groupValue(definition, primary);
        break;
      }
      case "allow-any":
      case "restrict-any": {
        merged[definition.key] = booleanGranted(definition, groups) ?? definition.defaultValue;
        break;
      }
      case "max":
      case "min": {
        const values = numericValues(definition, groups);

        if (values.length === 0) {
          merged[definition.key] = definition.defaultValue;
        } else {
          merged[definition.key] =
            definition.merge === "max" ? Math.max(...values) : Math.min(...values);
        }
        break;
      }
    }
  }

  return merged;
}
