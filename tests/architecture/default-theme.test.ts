import { describe, expect, test } from "bun:test";
import {
  auditHooks,
  declaredIslandsIn,
  HOOK_NAMES,
  loadDefaultThemeTemplates,
  loadDemoHookFragments,
  missingDeclaredIslands,
} from "@bulletin/templates";
import { ROUTE_CONTRACTS } from "../../apps/user-app/src/contracts.ts";

// Task 3.2 and 4.1: CI checks the default theme's source files for every registered hook,
// every route's required islands, and the demo hook fragment. Task 8.2 seeds these files.

function without(source: string, pattern: RegExp): string {
  return source.replace(pattern, "");
}

describe("default theme checks", () => {
  test("the route contracts and the hook registry are not vacuously satisfied", () => {
    expect(HOOK_NAMES).toContain("demo.after.topics");
    expect(ROUTE_CONTRACTS["/_demo/[id]"]?.requiredIslands).toContain("SpikeCounter");
  });

  test("every demo hook fragment is in the hook registry", async () => {
    const fragments = await loadDemoHookFragments();

    for (const name of Object.keys(fragments)) {
      expect(HOOK_NAMES).toContain(name);
    }
  });

  test("contains every registered hook point and no unregistered hook", async () => {
    expect(auditHooks(await loadDefaultThemeTemplates())).toEqual({
      missingRegistered: [],
      unregistered: [],
    });
  });

  test("declares every island each route requires", async () => {
    const templates = await loadDefaultThemeTemplates();

    expect(declaredIslandsIn(templates)).toEqual(
      expect.arrayContaining(["LanguageSwitcher", "SpikeCounter", "LocaleSuggestion"]),
    );

    for (const contract of Object.values(ROUTE_CONTRACTS)) {
      expect({
        route: contract.route,
        missing: missingDeclaredIslands(templates, contract.requiredIslands),
      }).toEqual({ route: contract.route, missing: [] });
    }
  });

  test("fails naming the island when a required island is missing", async () => {
    const templates = await loadDefaultThemeTemplates();
    const incomplete = Object.fromEntries(
      Object.entries(templates).map(([name, source]) => [
        name,
        without(source, /\{%-?\s*island\s+"SpikeCounter"[^%]*%\}/),
      ]),
    );

    expect(declaredIslandsIn(incomplete)).not.toContain("SpikeCounter");
    expect(missingDeclaredIslands(incomplete, ["SpikeCounter"])).toEqual(["SpikeCounter"]);
  });

  test("fails naming the hook when a registered hook is missing", async () => {
    const templates = await loadDefaultThemeTemplates();
    const incomplete = Object.fromEntries(
      Object.entries(templates).map(([name, source]) => [
        name,
        without(source, /\{%-?\s*hook\s+"demo\.after\.topics"[^%]*%\}/),
      ]),
    );

    expect(auditHooks(incomplete)).toEqual({
      missingRegistered: ["demo.after.topics"],
      unregistered: [],
    });
  });
});
