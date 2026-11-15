import type { PermissionKey } from "@bulletin/domain/permissions";

/** Top-level areas shown in the staff icon rail (ADR 0021). */
export type StaffArea =
  | "overview"
  | "members"
  | "content"
  | "moderation"
  | "appearance"
  | "integrations"
  | "privacy"
  | "system";

export interface StaffNavGroup {
  readonly id: string;
  readonly labelKey: string;
}

export interface StaffAreaDefinition {
  readonly id: StaffArea;
  readonly labelKey: string;
  /** Groups in the sub-navigation panel, in display order. */
  readonly groups: readonly StaffNavGroup[];
}

/** Section metadata only; route components are attached in `section-routes.tsx`. */
export interface StaffSection {
  readonly id: string;
  readonly path: string;
  readonly area: StaffArea;
  /** A group id from the area's `groups`. */
  readonly group: string;
  readonly permission: PermissionKey;
  readonly labelKey: string;
}

/** The rail areas and their panel groups. Labels are literal keys so the i18n check sees them. */
export const STAFF_AREAS: readonly StaffAreaDefinition[] = [
  {
    id: "overview",
    labelKey: "staff.area.overview",
    groups: [
      { id: "overview", labelKey: "staff.navGroup.overview.overview" },
      { id: "activity", labelKey: "staff.navGroup.overview.activity" },
    ],
  },
  {
    id: "members",
    labelKey: "staff.area.members",
    groups: [
      { id: "directory", labelKey: "staff.navGroup.members.directory" },
      { id: "access", labelKey: "staff.navGroup.members.access" },
      { id: "profiles", labelKey: "staff.navGroup.members.profiles" },
    ],
  },
  {
    id: "content",
    labelKey: "staff.area.content",
    groups: [
      { id: "forums", labelKey: "staff.navGroup.content.forums" },
      { id: "posting", labelKey: "staff.navGroup.content.posting" },
    ],
  },
  {
    id: "moderation",
    labelKey: "staff.area.moderation",
    groups: [
      { id: "general", labelKey: "staff.navGroup.moderation.general" },
      { id: "discipline", labelKey: "staff.navGroup.moderation.discipline" },
      { id: "records", labelKey: "staff.navGroup.moderation.records" },
    ],
  },
  {
    id: "appearance",
    labelKey: "staff.area.appearance",
    groups: [
      { id: "themes", labelKey: "staff.navGroup.appearance.themes" },
      { id: "language", labelKey: "staff.navGroup.appearance.language" },
    ],
  },
  {
    id: "integrations",
    labelKey: "staff.area.integrations",
    groups: [
      { id: "extensions", labelKey: "staff.navGroup.integrations.extensions" },
      { id: "developers", labelKey: "staff.navGroup.integrations.developers" },
    ],
  },
  {
    id: "privacy",
    labelKey: "staff.area.privacy",
    groups: [
      { id: "requests", labelKey: "staff.navGroup.privacy.requests" },
      { id: "policy", labelKey: "staff.navGroup.privacy.policy" },
      { id: "audit", labelKey: "staff.navGroup.privacy.audit" },
    ],
  },
  {
    id: "system",
    labelKey: "staff.area.system",
    groups: [
      { id: "configuration", labelKey: "staff.navGroup.system.configuration" },
      { id: "health", labelKey: "staff.navGroup.system.health" },
    ],
  },
];

/** Every staff section, in navigation order. Navigation, breadcrumbs and route guards derive from this list. */
export const STAFF_SECTIONS: readonly StaffSection[] = [
  {
    id: "dashboard",
    path: "/",
    area: "overview",
    group: "overview",
    permission: "acp.access",
    labelKey: "staff.nav.dashboard",
  },
  {
    id: "adminLog",
    path: "/log",
    area: "overview",
    group: "activity",
    permission: "acp.log",
    labelKey: "staff.nav.adminLog",
  },
  {
    id: "memberProfiles",
    path: "/members/profiles",
    area: "members",
    group: "directory",
    permission: "acp.members",
    labelKey: "staff.nav.memberProfiles",
  },
  {
    id: "memberGroups",
    path: "/members/groups",
    area: "members",
    group: "directory",
    permission: "acp.members.groups",
    labelKey: "staff.nav.memberGroups",
  },
  {
    id: "memberReputation",
    path: "/members/reputation",
    area: "members",
    group: "directory",
    permission: "acp.members",
    labelKey: "staff.nav.memberReputation",
  },
  {
    id: "groups",
    path: "/groups",
    area: "members",
    group: "access",
    permission: "acp.groups",
    labelKey: "staff.nav.groups",
  },
  {
    id: "groupSettings",
    path: "/groups/settings",
    area: "members",
    group: "access",
    permission: "acp.groups",
    labelKey: "staff.nav.groupSettings",
  },
  {
    id: "permissions",
    path: "/permissions",
    area: "members",
    group: "access",
    permission: "acp.permissions",
    labelKey: "staff.nav.permissions",
  },
  {
    id: "promotions",
    path: "/promotions",
    area: "members",
    group: "access",
    permission: "acp.groups",
    labelKey: "staff.nav.promotions",
  },
  {
    id: "profileFields",
    path: "/members/profile-fields",
    area: "members",
    group: "profiles",
    permission: "acp.profile_fields",
    labelKey: "staff.nav.profileFields",
  },
  {
    id: "ranks",
    path: "/ranks",
    area: "members",
    group: "profiles",
    permission: "acp.ranks",
    labelKey: "staff.nav.ranks",
  },
  {
    id: "badges",
    path: "/badges",
    area: "members",
    group: "profiles",
    permission: "acp.badges",
    labelKey: "staff.nav.badges",
  },
  {
    id: "forums",
    path: "/forums",
    area: "content",
    group: "forums",
    permission: "acp.forums",
    labelKey: "staff.nav.forums",
  },
  {
    id: "prefixes",
    path: "/forums/prefixes",
    area: "content",
    group: "forums",
    permission: "acp.forums",
    labelKey: "staff.nav.prefixes",
  },
  {
    id: "announcements",
    path: "/announcements",
    area: "content",
    group: "forums",
    permission: "acp.announcements",
    labelKey: "staff.nav.announcements",
  },
  {
    id: "reactions",
    path: "/reactions",
    area: "content",
    group: "posting",
    permission: "acp.reactions",
    labelKey: "staff.nav.reactions",
  },
  {
    id: "emoticons",
    path: "/settings/emoticons",
    area: "content",
    group: "posting",
    permission: "acp.emoticons",
    labelKey: "staff.nav.emoticons",
  },
  {
    id: "filters",
    path: "/settings/filters",
    area: "content",
    group: "posting",
    permission: "acp.filters",
    labelKey: "staff.nav.filters",
  },
  {
    id: "moderation",
    path: "/moderation",
    area: "moderation",
    group: "general",
    permission: "acp.members",
    labelKey: "staff.nav.moderation",
  },
  {
    id: "moderators",
    path: "/moderators",
    area: "moderation",
    group: "general",
    permission: "acp.members",
    labelKey: "staff.nav.moderators",
  },
  {
    id: "multimod",
    path: "/moderation/multimod",
    area: "moderation",
    group: "general",
    permission: "acp.groups",
    labelKey: "staff.nav.multimod",
  },
  {
    id: "warnings",
    path: "/moderation/warnings",
    area: "moderation",
    group: "discipline",
    permission: "acp.warnings",
    labelKey: "staff.nav.warnings",
  },
  {
    id: "bans",
    path: "/moderation/bans",
    area: "moderation",
    group: "discipline",
    permission: "acp.members",
    labelKey: "staff.nav.bans",
  },
  {
    id: "moderationLog",
    path: "/moderation/log",
    area: "moderation",
    group: "records",
    permission: "acp.log",
    labelKey: "staff.nav.moderationLog",
  },
  {
    id: "themes",
    path: "/themes",
    area: "appearance",
    group: "themes",
    permission: "acp.themes",
    labelKey: "staff.nav.themes",
  },
  {
    id: "stringOverrides",
    path: "/settings/strings",
    area: "appearance",
    group: "language",
    permission: "acp.strings",
    labelKey: "staff.nav.strings",
  },
  {
    id: "plugins",
    path: "/plugins",
    area: "integrations",
    group: "extensions",
    permission: "acp.plugins",
    labelKey: "staff.nav.plugins",
  },
  {
    id: "apiKeys",
    path: "/settings/api-keys",
    area: "integrations",
    group: "developers",
    permission: "acp.api",
    labelKey: "staff.nav.apiKeys",
  },
  {
    id: "webhooks",
    path: "/settings/webhooks",
    area: "integrations",
    group: "developers",
    permission: "acp.webhooks",
    labelKey: "staff.nav.webhooks",
  },
  {
    id: "privacyRequests",
    path: "/privacy/requests",
    area: "privacy",
    group: "requests",
    permission: "privacy.requests",
    labelKey: "staff.nav.privacyRequests",
  },
  {
    id: "privacyRetention",
    path: "/privacy/retention",
    area: "privacy",
    group: "policy",
    permission: "privacy.manage",
    labelKey: "staff.nav.privacyRetention",
  },
  {
    id: "privacyPolicy",
    path: "/privacy/policy",
    area: "privacy",
    group: "policy",
    permission: "privacy.manage",
    labelKey: "staff.nav.privacyPolicy",
  },
  {
    id: "privacyAudit",
    path: "/privacy/access-log",
    area: "privacy",
    group: "audit",
    permission: "privacy.audit",
    labelKey: "staff.nav.privacyAudit",
  },
  {
    id: "boardSettings",
    path: "/settings/board",
    area: "system",
    group: "configuration",
    permission: "acp.settings",
    labelKey: "staff.nav.boardSettings",
  },
  {
    id: "flags",
    path: "/flags",
    area: "system",
    group: "configuration",
    permission: "acp.flags",
    labelKey: "staff.nav.flags",
  },
  {
    id: "systemHealth",
    path: "/system/health",
    area: "system",
    group: "health",
    permission: "acp.system",
    labelKey: "staff.nav.systemHealth",
  },
  {
    id: "missingObjects",
    path: "/system/missing-objects",
    area: "system",
    group: "health",
    permission: "acp.system",
    labelKey: "staff.nav.missingObjects",
  },
  {
    id: "deadLetters",
    path: "/system/dead-letters",
    area: "system",
    group: "health",
    permission: "acp.system",
    labelKey: "staff.nav.deadLetters",
  },
];

/** Sections that only exist while their feature flag is on (ADR 0010). */
const SECTION_FLAG_KEYS: Readonly<Record<string, string>> = {
  plugins: "plugins",
  announcements: "announcements",
  warnings: "warnings",
  multimod: "multimod",
  apiKeys: "public_api",
  webhooks: "webhooks",
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

export interface StaffNavGroupView {
  readonly group: StaffNavGroup;
  readonly sections: readonly StaffSection[];
}

export interface StaffAreaView {
  readonly area: StaffAreaDefinition;
  readonly groups: readonly StaffNavGroupView[];
  /** Where the rail sends you: the area's first section you can open. */
  readonly home: StaffSection;
}

/** Areas with at least one reachable section, each with its non-empty groups. */
export function navigationAreas(sections: readonly StaffSection[]): StaffAreaView[] {
  const views: StaffAreaView[] = [];

  for (const area of STAFF_AREAS) {
    const groups = area.groups
      .map((group) => ({
        group,
        sections: sections.filter(
          (section) => section.area === area.id && section.group === group.id,
        ),
      }))
      .filter((view) => view.sections.length > 0);
    const home = groups[0]?.sections[0];

    if (home !== undefined) {
      views.push({ area, groups, home });
    }
  }

  return views;
}

export function areaDefinition(id: StaffArea): StaffAreaDefinition {
  const area = STAFF_AREAS.find((candidate) => candidate.id === id);

  if (area === undefined) {
    throw new Error(`staff-app: unknown area ${id}`);
  }

  return area;
}

/** The section whose path matches the current location, preferring the longest match. */
export function sectionForPath(
  sections: readonly StaffSection[],
  pathname: string,
): StaffSection | undefined {
  const normalised = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const exact = sections.find((section) => section.path === normalised);

  if (exact !== undefined) {
    return exact;
  }

  return [...sections]
    .filter((section) => section.path !== "/" && normalised.startsWith(`${section.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}
