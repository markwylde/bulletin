import { describe, expect, test } from "bun:test";
import {
  canAccessSection,
  STAFF_SECTIONS,
  type StaffSection,
  sectionsWithFlags,
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

  test("shows the plugin manager only with acp.plugins", () => {
    expect(visibleSections(["acp.access"]).map((section) => section.id)).not.toContain("plugins");
    expect(visibleSections(["acp.access", "acp.plugins"]).map((section) => section.id)).toContain(
      "plugins",
    );
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

  test("hides warnings and multimod sections while their flags are off", () => {
    const permissions = ["acp.access", "acp.warnings", "acp.groups", "acp.announcements"];
    const withoutFlags = sectionsWithFlags(visibleSections(permissions), {}).map(
      (section) => section.id,
    );

    expect(withoutFlags).not.toContain("warnings");
    expect(withoutFlags).not.toContain("multimod");
    expect(withoutFlags).not.toContain("announcements");

    const withFlags = sectionsWithFlags(visibleSections(permissions), {
      warnings: true,
      multimod: true,
      announcements: true,
    }).map((section) => section.id);

    expect(withFlags).toContain("warnings");
    expect(withFlags).toContain("multimod");
    expect(withFlags).toContain("announcements");
  });

  test("hides the API key and webhook screens while their flags are off", () => {
    const permissions = ["acp.access", "acp.api", "acp.webhooks"];

    expect(
      sectionsWithFlags(visibleSections(permissions), {}).map((section) => section.id),
    ).toEqual(["dashboard"]);
    expect(
      sectionsWithFlags(visibleSections(permissions), {
        public_api: true,
        webhooks: true,
      }).map((section) => section.id),
    ).toEqual(["dashboard", "webhooks", "apiKeys"]);
  });

  test("shows dead letters only with acp.system", () => {
    expect(visibleSections(["acp.access", "acp.log"]).map((section) => section.id)).not.toContain(
      "deadLetters",
    );
    expect(visibleSections(["acp.access", "acp.system"]).map((section) => section.id)).toContain(
      "deadLetters",
    );
  });
});
