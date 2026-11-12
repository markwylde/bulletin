import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  auditHooks,
  checkThemeContrast,
  DEFAULT_THEME_CONTRAST_PAIRS,
  DEFAULT_THEME_TEMPLATE_NAMES,
  declaredIslandsIn,
  HOOK_NAMES,
  loadDefaultThemeTemplates,
  loadDefaultThemeTokens,
  loadDemoHookFragments,
  missingCompositionIslands,
} from "@bulletin/templates";
import { ROUTE_CONTRACTS } from "../../apps/user-app/src/contracts.ts";

// Task 3.2 and 4.1: CI checks the default theme's source files for every registered hook,
// every route's required islands, and the demo hook fragment. Task 8.2 seeds these files.

const THEME_DIR = fileURLToPath(
  new URL("../../packages/templates/themes/default/", import.meta.url),
);
const STYLESHEET = fileURLToPath(
  new URL("../../apps/user-app/src/theme/default.css", import.meta.url),
);

function without(source: string, pattern: RegExp): string {
  return source.replace(pattern, "");
}

function declarations(block: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};

  for (const match of block.matchAll(/--bl-([a-z-]+):\s*([^;]+);/g)) {
    if (match[1] !== undefined && match[2] !== undefined) {
      values[match[1]] = match[2].trim();
    }
  }

  return values;
}

/** The `:root` declarations for light and the dark media query's overrides. */
async function stylesheetTokens(): Promise<{
  readonly light: Readonly<Record<string, string>>;
  readonly dark: Readonly<Record<string, string>>;
}> {
  const source = await Bun.file(STYLESHEET).text();
  const light = /:root \{([\s\S]*?)\n\}/.exec(source);
  const dark = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n {2}\}/.exec(source);

  if (light?.[1] === undefined || dark?.[1] === undefined) {
    throw new Error("Could not read the default theme's light and dark token blocks");
  }

  return { light: declarations(light[1]), dark: declarations(dark[1]) };
}

const colourTokens = [
  ...new Set(DEFAULT_THEME_CONTRAST_PAIRS.flatMap((pair) => [pair.foreground, pair.background])),
];

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

  test("every page provides the skip-link target", async () => {
    const templates = await loadDefaultThemeTemplates();
    const missing = Object.entries(templates)
      .filter(([, source]) => source.includes("<main") && !source.includes('id="main"'))
      .map(([name]) => name);

    expect(missing).toEqual([]);
  });

  test("the template list matches the files on disk", async () => {
    const files = new Bun.Glob("*.liquid").scan({ cwd: THEME_DIR, onlyFiles: true });
    const names: string[] = [];

    for await (const file of files) {
      names.push(file.replace(/\.liquid$/, ""));
    }

    expect(names.sort()).toEqual([...DEFAULT_THEME_TEMPLATE_NAMES].sort());
  });

  test("every route's page and regions have a default theme template", async () => {
    const templates = new Set(DEFAULT_THEME_TEMPLATE_NAMES);
    const missing: string[] = [];

    for (const contract of Object.values(ROUTE_CONTRACTS)) {
      for (const name of [contract.templates.page, ...contract.templates.regions]) {
        if (!templates.has(name)) {
          missing.push(`${contract.route}: ${name}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test("the stylesheet and the tokens file agree for both schemes and pass WCAG AA", async () => {
    const tokens = await loadDefaultThemeTokens();
    const css = await stylesheetTokens();

    for (const token of colourTokens) {
      expect({ token, light: css.light[token] }).toEqual({ token, light: tokens.light[token] });
      expect({ token, dark: css.dark[token] }).toEqual({ token, dark: tokens.dark[token] });
    }

    for (const [token, value] of Object.entries(tokens.light)) {
      expect({ token, value: css.light[token] }).toEqual({ token, value });
    }

    expect(checkThemeContrast(tokens)).toEqual([]);
  });
});
