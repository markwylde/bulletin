import { describe, expect, test } from "bun:test";
import {
  createCompileCache,
  createTemplateEngine,
  type TemplateEngine,
  type TemplateViolation,
} from "./index.ts";
import { buildTheme } from "./theme-fixtures.ts";

const ISLANDS = {};

function engine(options: { readonly parseLimit?: number } = {}): TemplateEngine {
  return createTemplateEngine({ islands: ISLANDS, limits: options });
}

function theme(overrides: { readonly leafVersion?: number; readonly parentVersion?: number } = {}) {
  return buildTheme([
    {
      name: "child",
      version: overrides.leafVersion ?? 1,
      templates: { page: "<p>child {{ title }}</p>" },
    },
    {
      name: "parent",
      version: overrides.parentVersion ?? 1,
      templates: { page: "<p>parent</p>", footer: "<footer>parent footer</footer>" },
    },
  ]);
}

describe("compile cache", () => {
  test("compiles every override and keeps the fallback order leaf first", () => {
    const cache = createCompileCache(engine());
    const compiled = cache.compile(theme(), 1);

    expect(compiled.templates("page").map((template) => template.themeName)).toEqual([
      "child",
      "parent",
    ]);
    expect(compiled.templates("footer").map((template) => template.themeName)).toEqual(["parent"]);
    expect(compiled.templates("missing")).toEqual([]);
    expect(compiled.violations).toEqual([]);
    expect(cache.size).toBe(1);
  });

  test("reuses the compiled theme until a version or the plugin generation changes", () => {
    const cache = createCompileCache(engine());
    const first = cache.compile(theme(), 1);

    expect(cache.compile(theme(), 1)).toBe(first);
    expect(cache.compile(theme({ leafVersion: 2 }), 1)).not.toBe(first);
    expect(cache.compile(theme({ parentVersion: 2 }), 1).key).not.toBe(first.key);
    expect(cache.compile(theme(), 2).key).not.toBe(first.key);
    expect(cache.size).toBe(4);
  });

  test("keys on the whole chain so a parent edit recompiles the child", () => {
    const cache = createCompileCache(engine());

    expect(cache.compile(theme({ parentVersion: 2 }), 1).key).not.toBe(
      cache.compile(theme({ parentVersion: 1 }), 1).key,
    );
  });

  test("drops an override that exceeds the parse limit and reports it", () => {
    const violations: TemplateViolation[] = [];
    const cache = createCompileCache(engine({ parseLimit: 40 }), {
      onViolation: (violation) => violations.push(violation),
    });
    const compiled = cache.compile(
      buildTheme([
        {
          name: "child",
          templates: {
            page: `<p>${"x".repeat(200)}</p>`,
            footer: "<footer>child footer</footer>",
          },
        },
        { name: "parent", templates: { page: "<p>parent</p>" } },
      ]),
      1,
    );

    expect(compiled.templates("page").map((template) => template.themeName)).toEqual(["parent"]);
    expect(compiled.templates("footer").map((template) => template.themeName)).toEqual(["child"]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.template).toBe("page");
    expect(violations[0]?.kind).toBe("compile");
    expect(violations[0]?.message).toContain("limit exceeded");
  });
});
