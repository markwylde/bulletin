import type { ComponentType } from "react";
import { DashboardPage } from "./dashboard/DashboardPage.tsx";
import type { StaffSection } from "./sections.ts";

/** The route component for each section id. */
export const SECTION_ELEMENTS: Readonly<Record<string, ComponentType>> = {
  dashboard: DashboardPage,
};

export function sectionElement(section: StaffSection): ComponentType | null {
  return SECTION_ELEMENTS[section.id] ?? null;
}
