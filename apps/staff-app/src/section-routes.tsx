import type { ComponentType } from "react";
import { DashboardPage } from "./dashboard/DashboardPage.tsx";
import { FlagsPage } from "./flags/FlagsPage.tsx";
import { AdminLogPage } from "./log/AdminLogPage.tsx";
import type { StaffSection } from "./sections.ts";
import { BoardSettingsPage } from "./settings/BoardSettingsPage.tsx";
import { StringOverridesPage } from "./strings/StringOverridesPage.tsx";

/** The route component for each section id. */
export const SECTION_ELEMENTS: Readonly<Record<string, ComponentType>> = {
  dashboard: DashboardPage,
  adminLog: AdminLogPage,
  boardSettings: BoardSettingsPage,
  stringOverrides: StringOverridesPage,
  flags: FlagsPage,
};

export function sectionElement(section: StaffSection): ComponentType | null {
  return SECTION_ELEMENTS[section.id] ?? null;
}
