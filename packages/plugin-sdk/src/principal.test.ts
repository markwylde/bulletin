import { describe, expect, test } from "bun:test";
import { allowsAccess, createPrincipal, GUEST } from "./principal.ts";

const STAFF = { memberId: "admin-1", scopes: ["staff"] };
const GUESTS = { memberId: "service", scopes: ["guests"] };

describe("viewer-context principal", () => {
  test("allows an operation only when capability, viewer and service principal all allow it", () => {
    expect(allowsAccess({ capability: true, viewer: true, service: true })).toBe(true);
    expect(allowsAccess({ capability: false, viewer: true, service: true })).toBe(false);
    expect(allowsAccess({ capability: true, viewer: false, service: true })).toBe(false);
    expect(allowsAccess({ capability: true, viewer: true, service: false })).toBe(false);
  });

  test("a Guests-level plugin serving an admin cannot read staff-only content", () => {
    const principal = createPrincipal({
      viewer: { memberId: "admin-1" },
      servicePrincipal: GUESTS,
      capabilities: ["core.read"],
    });

    // The viewer may read it, but the plugin's background identity may not.
    expect(principal.can({ capability: "core.read", viewer: true, service: false })).toBe(false);
  });

  test("a privileged plugin serving a guest cannot read through the guest", () => {
    const principal = createPrincipal({
      viewer: GUEST,
      servicePrincipal: STAFF,
      capabilities: ["core.read"],
    });

    expect(principal.can({ capability: "core.read", viewer: false, service: true })).toBe(false);
  });

  test("the intersection permits guest-readable public content", () => {
    const principal = createPrincipal({
      viewer: GUEST,
      servicePrincipal: GUESTS,
      capabilities: ["core.read"],
    });

    expect(principal.can({ capability: "core.read", viewer: true, service: true })).toBe(true);
    expect(principal.can({ capability: "core.write", viewer: true, service: true })).toBe(false);
  });
});

describe("privileged read then guest read", () => {
  test("a staff viewer cannot make a Guests-level plugin persist staff content", () => {
    const pluginStore: string[] = [];
    const principal = createPrincipal({
      viewer: { memberId: "admin-1" },
      servicePrincipal: GUESTS,
      capabilities: ["core.read"],
    });

    // The plugin tries to read a staff-only topic for the admin.
    if (principal.can({ capability: "core.read", viewer: true, service: false })) {
      pluginStore.push("staff-only topic");
    }

    // It cannot persist the content on this request, so there is nothing to show a guest.
    expect(pluginStore).toEqual([]);
  });
});
