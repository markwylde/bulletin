import { describe, expect, test } from "bun:test";
import {
  createCompileCache,
  createTemplateEngine,
  type TemplateEngine,
  type TemplateViolation,
  themeContentKey,
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

describe("themeContentKey", () => {
  test("changes with a template-row, leaf or parent version", () => {
    const base = theme();
    const bumpedTemplate = buildTheme([
      {
        name: "child",
        templates: { page: "<p>child {{ title }}</p>", footer: "<footer>new</footer>" },
      },
      {
        name: "parent",
        templates: { page: "<p>parent</p>", footer: "<footer>parent footer</footer>" },
      },
    ]);
    // Same bodies, different parent version: a parent edit must change the fingerprint.
    const parentBumped = theme({ parentVersion: 2 });

    expect(themeContentKey(base)).toBe(themeContentKey(base));
    expect(themeContentKey(base)).not.toBe(themeContentKey(theme({ leafVersion: 2 })));
    expect(themeContentKey(base)).not.toBe(themeContentKey(parentBumped));
    expect(themeContentKey(base)).not.toBe(themeContentKey(bumpedTemplate));
  });
});

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

  test("charges retained source and AST bytes against a byte budget", () => {
    const body = "x".repeat(4_000);
    const themeA = buildTheme([{ name: "a", templates: { page: `<p>${body}</p>` } }]);
    const themeB = buildTheme([{ name: "b", version: 2, templates: { page: `<p>${body}</p>` } }]);
    const probe = createCompileCache(engine());

    probe.compile(themeA, 1);

    // One theme retains far more than the token-sized charge a count-based cache used.
    expect(probe.bytes).toBeGreaterThan(Buffer.byteLength(body));

    const cache = createCompileCache(engine(), { maxBytes: probe.bytes });
    const first = cache.compile(themeA, 1);

    cache.compile(themeB, 1);

    expect(cache.size).toBe(1);
    expect(cache.bytes).toBeLessThanOrEqual(probe.bytes);
    // The evicted theme is compiled again instead of being served from the cache.
    expect(cache.compile(themeA, 1)).not.toBe(first);
  });

  test("does not retain a theme larger than the whole byte budget", () => {
    const cache = createCompileCache(engine(), { maxBytes: 64 });

    cache.compile(buildTheme([{ name: "large", templates: { page: "<p>a long body</p>" } }]), 1);

    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
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
