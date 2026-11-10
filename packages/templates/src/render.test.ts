import { describe, expect, test } from "bun:test";
import { createServerT } from "@bulletin/i18n";
import {
  createCompileCache,
  createTemplateEngine,
  renderThemeTemplate,
  type TemplateEngine,
  TemplateRenderError,
  type TemplateRuntime,
} from "./index.ts";
import { buildTheme } from "./theme-fixtures.ts";

const runtime: TemplateRuntime = { translate: createServerT("en"), hooks: {} };

function engine(): TemplateEngine {
  return createTemplateEngine({ islands: {} });
}

describe("renderThemeTemplate", () => {
  test("renders the theme's own override first", async () => {
    const compiled = createCompileCache(engine()).compile(
      buildTheme([
        { name: "child", templates: { page: "<p>child {{ title }}</p>" } },
        { name: "parent", templates: { page: "<p>parent</p>" } },
      ]),
      1,
    );
    const rendered = await renderThemeTemplate({
      engine: engine(),
      compiled,
      name: "page",
      viewModel: { title: "A" },
      runtime,
    });

    expect(rendered.html).toBe("<p>child A</p>");
    expect(rendered.template.themeName).toBe("child");
    expect(rendered.violations).toEqual([]);
  });

  test("falls back to the parent when the child exceeds the render limit", async () => {
    const activeEngine = engine();
    const compiled = createCompileCache(activeEngine).compile(
      buildTheme([
        {
          name: "child",
          templates: {
            page: "{% for i in (1..5000000) %}{{ i }}{% endfor %}",
          },
        },
        { name: "parent", templates: { page: "<p>parent fallback</p>" } },
      ]),
      1,
    );

    const rendered = await renderThemeTemplate({
      engine: activeEngine,
      compiled,
      name: "page",
      viewModel: {},
      runtime,
      limits: { renderLimit: 5 },
    });

    expect(rendered.html).toBe("<p>parent fallback</p>");
    expect(rendered.template.themeName).toBe("parent");
    expect(rendered.violations).toHaveLength(1);
    expect(rendered.violations[0]?.kind).toBe("render");
    expect(rendered.violations[0]?.theme).toBe("child");
    expect(rendered.violations[0]?.message).toContain("render limit exceeded");
  });

  test("falls back to the parent when the child exceeds the output limit", async () => {
    const activeEngine = engine();
    const compiled = createCompileCache(activeEngine).compile(
      buildTheme([
        { name: "child", templates: { page: "{{ long }}" } },
        { name: "parent", templates: { page: "<p>short</p>" } },
      ]),
      1,
    );

    const rendered = await renderThemeTemplate({
      engine: activeEngine,
      compiled,
      name: "page",
      viewModel: { long: "x".repeat(200) },
      runtime,
      limits: { outputLimit: 50 },
    });

    expect(rendered.html).toBe("<p>short</p>");
    expect(rendered.violations[0]?.kind).toBe("output");
    expect(rendered.violations[0]?.message).toContain("output limit exceeded");
  });

  test("reports a compile violation and renders the parent instead", async () => {
    const activeEngine = engine();
    const compiled = createCompileCache(activeEngine).compile(
      buildTheme([
        { name: "child", templates: { page: "<p>{{ title" } },
        { name: "parent", templates: { page: "<p>parent</p>" } },
      ]),
      1,
    );

    const rendered = await renderThemeTemplate({
      engine: activeEngine,
      compiled,
      name: "page",
      viewModel: {},
      runtime,
    });

    expect(rendered.html).toBe("<p>parent</p>");
    expect(rendered.violations[0]?.kind).toBe("compile");
    expect(rendered.violations[0]?.theme).toBe("child");
  });

  test("treats a filesystem include as a compile violation and renders the parent", async () => {
    const activeEngine = engine();
    const compiled = createCompileCache(activeEngine).compile(
      buildTheme([
        { name: "child", templates: { page: '<p>{% include "package.json" %}</p>' } },
        { name: "parent", templates: { page: "<p>parent</p>" } },
      ]),
      1,
    );

    const rendered = await renderThemeTemplate({
      engine: activeEngine,
      compiled,
      name: "page",
      viewModel: {},
      runtime,
    });

    expect(rendered.html).toBe("<p>parent</p>");
    expect(rendered.violations[0]?.kind).toBe("compile");
  });

  test("propagates template bugs that are not limit violations", async () => {
    const activeEngine = engine();
    const compiled = createCompileCache(activeEngine).compile(
      buildTheme([{ name: "child", templates: { page: "{{ missingField }}" } }]),
      1,
    );

    await expect(
      renderThemeTemplate({
        engine: activeEngine,
        compiled,
        name: "page",
        viewModel: {},
        runtime,
      }),
    ).rejects.toThrow();
  });

  test("throws when no theme provides the template", async () => {
    const activeEngine = engine();
    const compiled = createCompileCache(activeEngine).compile(
      buildTheme([{ name: "child", templates: { page: "<p>only</p>" } }]),
      1,
    );

    await expect(
      renderThemeTemplate({
        engine: activeEngine,
        compiled,
        name: "footer",
        viewModel: {},
        runtime,
      }),
    ).rejects.toBeInstanceOf(TemplateRenderError);
  });
});
