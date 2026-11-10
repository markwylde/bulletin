import { describe, expect, test } from "bun:test";
import {
  auditHooks,
  declaredIslandsIn,
  HOOK_NAMES,
  loadDefaultThemeTemplates,
  loadDemoHookFragments,
  missingCompositionIslands,
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

  test("declares every island each route requires in its own composition", async () => {
    const templates = await loadDefaultThemeTemplates();

    expect(declaredIslandsIn(templates)).toEqual(
      expect.arrayContaining(["LanguageSwitcher", "SpikeCounter", "LocaleSuggestion"]),
    );

    for (const contract of Object.values(ROUTE_CONTRACTS)) {
      expect({
        route: contract.route,
        missing: missingCompositionIslands(templates, contract.templates, contract.requiredIslands),
      }).toEqual({ route: contract.route, missing: [] });
    }
  });

  test("an island in an unrelated template does not satisfy a route", async () => {
    const templates = await loadDefaultThemeTemplates();
    const demo = ROUTE_CONTRACTS["/_demo/[id]"];
    const account = ROUTE_CONTRACTS["/account"];

    if (demo === undefined || account === undefined) {
      throw new Error("Missing route contracts");
    }

    // LanguageSwitcher lives in the header; removing it breaks the routes that only get it
    // from the header. The account page also places its own, so it still composes one.
    const headerWithoutSwitcher = templates.header?.replace(
      /\{%-?\s*island\s+"LanguageSwitcher"[^%]*%\}/g,
      "",
    );
    const broken = { ...templates, header: headerWithoutSwitcher ?? "" };

    for (const contract of [demo, ROUTE_CONTRACTS["/"], ROUTE_CONTRACTS["/auth/login"]]) {
      if (contract === undefined) {
        throw new Error("Missing route contract");
      }

      expect(
        missingCompositionIslands(broken, contract.templates, contract.requiredIslands),
      ).toContain("LanguageSwitcher");
    }

    expect(missingCompositionIslands(broken, account.templates, account.requiredIslands)).toEqual(
      [],
    );

    // Removing it from the account page too makes that route fail, and the demo route never
    // benefits from the account template's island.
    const bothRemoved = {
      ...broken,
      account: (templates.account ?? "").replace(
        /\{%-?\s*island\s+"LanguageSwitcher"[^%]*%\}/g,
        "",
      ),
    };

    expect(
      missingCompositionIslands(bothRemoved, account.templates, account.requiredIslands),
    ).toEqual(["LanguageSwitcher"]);
    expect(missingCompositionIslands(bothRemoved, demo.templates, demo.requiredIslands)).toEqual([
      "LanguageSwitcher",
    ]);
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
    expect(
      missingCompositionIslands(
        incomplete,
        ROUTE_CONTRACTS["/_demo/[id]"]?.templates ?? { page: "demo", regions: [] },
        ["SpikeCounter"],
      ),
    ).toEqual(["SpikeCounter"]);
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
