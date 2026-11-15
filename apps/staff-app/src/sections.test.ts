import { describe, expect, test } from "bun:test";
import {
  canAccessSection,
  navigationAreas,
  STAFF_AREAS,
  STAFF_SECTIONS,
  type StaffSection,
  sectionForPath,
  sectionsWithFlags,
  visibleSections,
} from "./sections.ts";

const settingsSection: StaffSection = {
  id: "settings",
  path: "/settings",
  area: "system",
  group: "configuration",
  permission: "acp.settings",
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

  test("shows the system health panel only with acp.system", () => {
    expect(
      visibleSections(["acp.access", "acp.members"]).map((section) => section.id),
    ).not.toContain("systemHealth");
    expect(visibleSections(["acp.access", "acp.system"]).map((section) => section.id)).toContain(
      "systemHealth",
    );
  });

  test("shows the missing-object listing only with acp.system", () => {
    expect(
      visibleSections(["acp.access", "acp.members"]).map((section) => section.id),
    ).not.toContain("missingObjects");
    expect(visibleSections(["acp.access", "acp.system"]).map((section) => section.id)).toContain(
      "missingObjects",
    );
  });

  test("shows retention only with privacy.manage", () => {
    expect(
      visibleSections(["acp.access", "acp.settings"]).map((section) => section.id),
    ).not.toContain("privacyRetention");
    expect(
      visibleSections(["acp.access", "privacy.manage"]).map((section) => section.id),
    ).toContain("privacyRetention");
  });

  test("shows privacy queue and audit only with their permissions", () => {
    expect(
      visibleSections(["acp.access", "privacy.requests"]).map((section) => section.id),
    ).toContain("privacyRequests");
    expect(
      visibleSections(["acp.access", "privacy.requests"]).map((section) => section.id),
    ).not.toContain("privacyAudit");
    expect(visibleSections(["acp.access", "privacy.audit"]).map((section) => section.id)).toContain(
      "privacyAudit",
    );
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
    ).toEqual(["dashboard", "apiKeys", "webhooks"]);
  });

  test("shows dead letters only with acp.system", () => {
    expect(visibleSections(["acp.access", "acp.log"]).map((section) => section.id)).not.toContain(
      "deadLetters",
    );
    expect(visibleSections(["acp.access", "acp.system"]).map((section) => section.id)).toContain(
      "deadLetters",
    );
  });

  test("puts every section in a declared area and group", () => {
    for (const section of STAFF_SECTIONS) {
      const area = STAFF_AREAS.find((candidate) => candidate.id === section.area);

      expect(area).toBeDefined();
      expect(area?.groups.map((group) => group.id)).toContain(section.group);
    }

    expect(new Set(STAFF_SECTIONS.map((section) => section.path)).size).toBe(STAFF_SECTIONS.length);
  });

  test("builds navigation only from reachable sections", () => {
    const areas = navigationAreas(visibleSections(["acp.access", "acp.system"]));

    expect(areas.map((view) => view.area.id)).toEqual(["overview", "system"]);
    expect(areas[1]?.home.id).toBe("systemHealth");
    expect(areas[1]?.groups.map((view) => view.group.id)).toEqual(["health"]);
    expect(navigationAreas(visibleSections(["acp.access"])).map((view) => view.area.id)).toEqual([
      "overview",
    ]);
  });

  test("resolves the section for a location, including nested paths", () => {
    expect(sectionForPath(STAFF_SECTIONS, "/")?.id).toBe("dashboard");
    expect(sectionForPath(STAFF_SECTIONS, "/moderation/bans")?.id).toBe("bans");
    expect(sectionForPath(STAFF_SECTIONS, "/moderation/bans/")?.id).toBe("bans");
    expect(sectionForPath(STAFF_SECTIONS, "/groups/settings")?.id).toBe("groupSettings");
    expect(sectionForPath(STAFF_SECTIONS, "/groups/42")?.id).toBe("groups");
    expect(sectionForPath(STAFF_SECTIONS, "/nowhere")).toBeUndefined();
  });
});
