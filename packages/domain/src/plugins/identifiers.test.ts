import { describe, expect, test } from "bun:test";
import { pluginIdentifiers, pluginRoleMarker, RESERVED_DATABASE_ROLES } from "./identifiers.ts";

describe("plugin database identifiers", () => {
  test("namespaces runtime and owner roles apart", () => {
    const demo = pluginIdentifiers("demo");
    const demoOwner = pluginIdentifiers("demo-owner");

    expect(demo.schema).toBe("plugin_demo");
    expect(demo.runtimeRole).toBe("plugin_rt__demo");
    expect(demo.ownerRole).toBe("plugin_own__demo");
    expect(demoOwner.runtimeRole).toBe("plugin_rt__demo_owner");
    expect(demoOwner.ownerRole).toBe("plugin_own__demo_owner");
  });

  test("never aliases a migrating plugin with the migrator role", () => {
    const migrator = pluginIdentifiers("migrator");

    expect(migrator.runtimeRole).not.toBe("plugin_migrator");
    expect(migrator.ownerRole).not.toBe("plugin_migrator");
    expect(RESERVED_DATABASE_ROLES.has(migrator.runtimeRole)).toBe(false);
    expect(RESERVED_DATABASE_ROLES.has(migrator.ownerRole)).toBe(false);
  });

  test("keeps every derived name within Postgres' 63-byte identifier limit", () => {
    const longest = pluginIdentifiers("a".repeat(49));

    for (const name of [longest.schema, longest.runtimeRole, longest.ownerRole]) {
      expect(name.length).toBeLessThanOrEqual(63);
    }
  });

  test("gives distinct plugins distinct namespaces", () => {
    const ids = ["demo", "demo-owner", "migrator", "a-b", "a-b-owner", "plugin-migrator"];
    const names = ids.flatMap((id) => {
      const identifiers = pluginIdentifiers(id);
      return [identifiers.schema, identifiers.runtimeRole, identifiers.ownerRole];
    });

    expect(new Set(names).size).toBe(names.length);
  });

  test("marks each plugin's roles with its own id", () => {
    expect(pluginRoleMarker("tip-jar")).toBe("bulletin:plugin:tip-jar");
    expect(pluginRoleMarker("tip-jar")).not.toBe(pluginRoleMarker("sandbox-demo"));
  });

  test("rejects ids the manifest parser would not accept", () => {
    expect(() => pluginIdentifiers("Demo")).toThrow(TypeError);
    expect(() => pluginIdentifiers("")).toThrow(TypeError);
    expect(() => pluginIdentifiers("a".repeat(50))).toThrow(TypeError);
  });
});
