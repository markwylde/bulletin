import { describe, expect, test } from "bun:test";
import {
  auditHooks,
  declaredIslandsIn,
  HOOK_NAMES,
  loadSpikeFixtures,
  missingDeclaredIslands,
  SPIKE_HOOK_NAME,
  type SpikeThemeFixture,
} from "@bulletin/templates";
import { ROUTE_CONTRACTS, spikeRenderingContract } from "../../apps/user-app/src/contracts.ts";

// Task 3.2: CI checks that the default theme places every hook point in the registry and
// every island a route requires. The theme's source files are the CI input; task 8.2 seeds
// the same files into Postgres.

async function defaultThemeTemplates(): Promise<Readonly<Record<string, string>>> {
  const fixtures = await loadSpikeFixtures();
  const theme = fixtures.themes.find(
    (candidate: SpikeThemeFixture) => candidate.name === "default",
  );

  if (theme === undefined) {
    throw new Error("The default theme fixture is missing");
  }

  return theme.templates;
}

function without(source: string, pattern: RegExp): string {
  return source.replace(pattern, "");
}

describe("default theme checks", () => {
  test("the route contracts and the hook registry are not vacuously satisfied", () => {
    expect(HOOK_NAMES).toContain(SPIKE_HOOK_NAME);
    expect(spikeRenderingContract.requiredIslands).toContain("SpikeCounter");
  });

  test("contains every registered hook point and no unregistered hook", async () => {
    expect(auditHooks(await defaultThemeTemplates())).toEqual({
      missingRegistered: [],
      unregistered: [],
    });
  });

  test("declares every island each route requires", async () => {
    const templates = await defaultThemeTemplates();

    expect(declaredIslandsIn(templates)).toContain("SpikeCounter");

    for (const contract of Object.values(ROUTE_CONTRACTS)) {
      expect({
        route: contract.route,
        missing: missingDeclaredIslands(templates, contract.requiredIslands),
      }).toEqual({ route: contract.route, missing: [] });
    }
  });

  test("fails naming the island when a required island is missing", async () => {
    const templates = await defaultThemeTemplates();
    const incomplete = Object.fromEntries(
      Object.entries(templates).map(([name, source]) => [
        name,
        without(source, /\{%-?\s*island\s+"SpikeCounter"[^%]*%\}/),
      ]),
    );

    expect(declaredIslandsIn(incomplete)).not.toContain("SpikeCounter");
    expect(missingDeclaredIslands(incomplete, spikeRenderingContract.requiredIslands)).toEqual([
      "SpikeCounter",
    ]);
  });

  test("fails naming the hook when a registered hook is missing", async () => {
    const templates = await defaultThemeTemplates();
    const incomplete = Object.fromEntries(
      Object.entries(templates).map(([name, source]) => [
        name,
        without(source, /\{%-?\s*hook\s+"spike\.after\.counter"[^%]*%\}/),
      ]),
    );

    expect(auditHooks(incomplete)).toEqual({
      missingRegistered: [SPIKE_HOOK_NAME],
      unregistered: [],
    });
  });
});
