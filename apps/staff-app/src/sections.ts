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
  | "promotions";

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
    id: "moderators",
    path: "/moderators",
    navGroup: "configuration",
    permission: "acp.members",
    icon: "moderators",
    labelKey: "staff.nav.moderators",
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

export function canAccessSection(permissions: readonly string[], section: StaffSection): boolean {
  return permissions.includes(section.permission);
}

export function visibleSections(
  permissions: readonly string[],
  sections: readonly StaffSection[] = STAFF_SECTIONS,
): StaffSection[] {
  return sections.filter((section) => canAccessSection(permissions, section));
}
