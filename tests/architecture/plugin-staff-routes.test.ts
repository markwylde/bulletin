import { describe, expect, test } from "bun:test";
import { STAFF_ROUTES } from "../../apps/staff-api/src/api.ts";
import { STAFF_SECTIONS } from "../../apps/staff-app/src/sections.ts";

// Task 5.2: every plugin-manager endpoint is gated on acp.plugins, and the manager section
// is visible only to members holding that permission.

describe("staff plugin integration permissions", () => {
  test("all plugin routes require acp.plugins", () => {
    const routes = STAFF_ROUTES.filter((route) => route.path.startsWith("/api/staff/plugins"));

    expect(routes.length).toBeGreaterThan(0);

    for (const route of routes) {
      expect(route.permission).toBe("acp.plugins");
    }
  });

  test("sensitive plugin actions require step-up", () => {
    const routes = STAFF_ROUTES.filter((route) => route.path.startsWith("/api/staff/plugins"));
    expect(routes.find((route) => route.id === "plugins.uninstall")?.requiresStepUp).toBe(true);
    expect(routes.find((route) => route.id === "plugins.grant")?.requiresStepUp).toBe(true);
  });

  test("the manager section is guarded by acp.plugins", () => {
    expect(STAFF_SECTIONS.find((section) => section.id === "plugins")).toMatchObject({
      path: "/plugins",
      permission: "acp.plugins",
    });
  });
});
