import { describe, expect, test } from "bun:test";
import {
  canAccessSection,
  STAFF_SECTIONS,
  type StaffSection,
  visibleSections,
} from "./sections.ts";

const settingsSection: StaffSection = {
  id: "settings",
  path: "/settings",
  navGroup: "overview",
  permission: "acp.settings",
  icon: "dashboard",
  labelKey: "staff.nav.dashboard",
};

describe("staff section registry", () => {
  test("exposes only the sections the member's permissions include", () => {
    const sections = [...STAFF_SECTIONS, settingsSection];

    expect(visibleSections(["acp.access"], sections).map((section) => section.id)).toEqual([
      "dashboard",
    ]);
    expect(
      visibleSections(["acp.access", "acp.settings"], sections).map((section) => section.id),
    ).toEqual(["dashboard", "boardSettings", "settings"]);
  });

  test("guards a section on its own permission", () => {
    expect(canAccessSection(["acp.access"], settingsSection)).toBe(false);
    expect(canAccessSection(["acp.access", "acp.settings"], settingsSection)).toBe(true);
  });

  test("renders dashboard for staff with acp.access only", () => {
    expect(visibleSections(["acp.access"]).map((section) => section.id)).toEqual(["dashboard"]);
    expect(visibleSections([]).map((section) => section.id)).toEqual([]);
  });

  test("shows the flags section only with acp.flags", () => {
    expect(
      visibleSections(["acp.access", "acp.settings"]).map((section) => section.id),
    ).not.toContain("flags");
    expect(visibleSections(["acp.access", "acp.flags"]).map((section) => section.id)).toContain(
      "flags",
    );
  });
});
