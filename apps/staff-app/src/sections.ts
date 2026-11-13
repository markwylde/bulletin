import type { AcpPermission } from "@bulletin/domain/permissions";

export type StaffNavGroup = "overview" | "configuration";

export type StaffIcon =
  | "dashboard"
  | "events"
  | "flags"
  | "settings"
  | "strings"
  | "log"
  | "groups"
  | "permissions"
  | "members"
  | "moderators"
  | "promotions"
  | "themes"
  | "plugins";

/** Section metadata only; route components are attached in `section-routes.tsx`. */
export interface StaffSection {
  readonly id: string;
  readonly path: string;
  readonly navGroup: StaffNavGroup;
  readonly permission: AcpPermission;
  readonly icon: StaffIcon;
  readonly labelKey: string;
}

/** Every staff section. Navigation and route guards are derived from this one list. */
export const STAFF_SECTIONS: readonly StaffSection[] = [
  {
    id: "dashboard",
    path: "/",
    navGroup: "overview",
    permission: "acp.access",
    icon: "dashboard",
    labelKey: "staff.nav.dashboard",
  },
  {
    id: "moderation",
    path: "/moderation",
    navGroup: "overview",
    permission: "acp.members",
    icon: "moderators",
    labelKey: "staff.nav.moderation",
  },
  {
    id: "bans",
    path: "/moderation/bans",
    navGroup: "overview",
    permission: "acp.members",
    icon: "moderators",
    labelKey: "staff.nav.bans",
  },
  {
    id: "warnings",
    path: "/moderation/warnings",
    navGroup: "overview",
    permission: "acp.warnings",
    icon: "moderators",
    labelKey: "staff.nav.warnings",
  },
  {
    id: "multimod",
    path: "/moderation/multimod",
    navGroup: "overview",
    permission: "acp.groups",
    icon: "moderators",
    labelKey: "staff.nav.multimod",
  },
  {
    id: "moderationLog",
    path: "/moderation/log",
    navGroup: "overview",
    permission: "acp.log",
    icon: "log",
    labelKey: "staff.nav.moderationLog",
  },
  {
    id: "adminLog",
    path: "/log",
    navGroup: "overview",
    permission: "acp.log",
    icon: "log",
    labelKey: "staff.nav.adminLog",
  },
  {
    id: "deadLetters",
    path: "/system/dead-letters",
    navGroup: "overview",
    permission: "acp.system",
    icon: "events",
    labelKey: "staff.nav.deadLetters",
  },
  {
    id: "boardSettings",
    path: "/settings/board",
    navGroup: "configuration",
    permission: "acp.settings",
    icon: "settings",
    labelKey: "staff.nav.boardSettings",
  },
  {
    id: "filters",
    path: "/settings/filters",
    navGroup: "configuration",
    permission: "acp.filters",
    icon: "settings",
    labelKey: "staff.nav.filters",
  },
  {
    id: "emoticons",
    path: "/settings/emoticons",
    navGroup: "configuration",
    permission: "acp.emoticons",
    icon: "settings",
    labelKey: "staff.nav.emoticons",
  },
  {
    id: "flags",
    path: "/flags",
    navGroup: "configuration",
    permission: "acp.flags",
    icon: "flags",
    labelKey: "staff.nav.flags",
  },
  {
    id: "webhooks",
    path: "/settings/webhooks",
    navGroup: "configuration",
    permission: "acp.webhooks",
    icon: "events",
    labelKey: "staff.nav.webhooks",
  },
  {
    id: "apiKeys",
    path: "/settings/api-keys",
    navGroup: "configuration",
    permission: "acp.api",
    icon: "settings",
    labelKey: "staff.nav.apiKeys",
  },
  {
    id: "stringOverrides",
    path: "/settings/strings",
    navGroup: "configuration",
    permission: "acp.strings",
    icon: "strings",
    labelKey: "staff.nav.strings",
  },
  {
    id: "groups",
    path: "/groups",
    navGroup: "configuration",
    permission: "acp.groups",
    icon: "groups",
    labelKey: "staff.nav.groups",
  },
  {
    id: "groupSettings",
    path: "/groups/settings",
    navGroup: "configuration",
    permission: "acp.groups",
    icon: "settings",
    labelKey: "staff.nav.groupSettings",
  },
  {
    id: "permissions",
    path: "/permissions",
    navGroup: "configuration",
    permission: "acp.permissions",
    icon: "permissions",
    labelKey: "staff.nav.permissions",
  },
  {
    id: "forums",
    path: "/forums",
    navGroup: "configuration",
    permission: "acp.forums",
    icon: "groups",
    labelKey: "staff.nav.forums",
  },
  {
    id: "prefixes",
    path: "/forums/prefixes",
    navGroup: "configuration",
    permission: "acp.forums",
    icon: "settings",
    labelKey: "staff.nav.prefixes",
  },
  {
    id: "announcements",
    path: "/announcements",
    navGroup: "configuration",
    permission: "acp.announcements",
    icon: "flags",
    labelKey: "staff.nav.announcements",
  },
  {
    id: "memberGroups",
    path: "/members/groups",
    navGroup: "configuration",
    permission: "acp.members.groups",
    icon: "members",
    labelKey: "staff.nav.memberGroups",
  },
  {
    id: "memberReputation",
    path: "/members/reputation",
    navGroup: "configuration",
    permission: "acp.members",
    icon: "members",
    labelKey: "staff.nav.memberReputation",
  },
  {
    id: "memberProfiles",
    path: "/members/profiles",
    navGroup: "configuration",
    permission: "acp.members",
    icon: "members",
    labelKey: "staff.nav.memberProfiles",
  },
  {
    id: "ranks",
    path: "/ranks",
    navGroup: "configuration",
    permission: "acp.ranks",
    icon: "promotions",
    labelKey: "staff.nav.ranks",
  },
  {
    id: "badges",
    path: "/badges",
    navGroup: "configuration",
    permission: "acp.badges",
    icon: "members",
    labelKey: "staff.nav.badges",
  },
  {
    id: "profileFields",
    path: "/members/profile-fields",
    navGroup: "configuration",
    permission: "acp.profile_fields",
    icon: "settings",
    labelKey: "staff.nav.profileFields",
  },
  {
    id: "moderators",
    path: "/moderators",
    navGroup: "configuration",
    permission: "acp.members",
    icon: "moderators",
    labelKey: "staff.nav.moderators",
  },
  {
    id: "reactions",
    path: "/reactions",
    navGroup: "configuration",
    permission: "acp.reactions",
    icon: "settings",
    labelKey: "staff.nav.reactions",
  },
  {
    id: "plugins",
    path: "/plugins",
    navGroup: "configuration",
    permission: "acp.plugins",
    icon: "plugins",
    labelKey: "staff.nav.plugins",
  },
  {
    id: "themes",
    path: "/themes",
    navGroup: "configuration",
    permission: "acp.themes",
    icon: "themes",
    labelKey: "staff.nav.themes",
  },
  {
    id: "promotions",
    path: "/promotions",
    navGroup: "configuration",
    permission: "acp.groups",
    icon: "promotions",
    labelKey: "staff.nav.promotions",
  },
];

/** Sections that only exist while their feature flag is on (ADR 0010). */
const SECTION_FLAG_KEYS: Readonly<Record<string, string>> = {
  plugins: "plugins",
  announcements: "announcements",
  warnings: "warnings",
  multimod: "multimod",
};

export function canAccessSection(permissions: readonly string[], section: StaffSection): boolean {
  return permissions.includes(section.permission);
}

export function visibleSections(
  permissions: readonly string[],
  sections: readonly StaffSection[] = STAFF_SECTIONS,
): StaffSection[] {
  return sections.filter((section) => canAccessSection(permissions, section));
}

/** Drops sections whose feature flag is off; every other section is flag-independent. */
export function sectionsWithFlags(
  sections: readonly StaffSection[],
  flags: Readonly<Record<string, boolean>>,
): StaffSection[] {
  return sections.filter((section) => {
    const key = SECTION_FLAG_KEYS[section.id];

    return key === undefined || flags[key] === true;
  });
}
