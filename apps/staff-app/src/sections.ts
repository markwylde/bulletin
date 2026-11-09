import type { AcpPermission } from "@bulletin/domain/permissions";

export type StaffNavGroup = "overview";

export type StaffIcon = "dashboard";

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
