import { describe, expect, test } from "bun:test";
import { createServerT } from "@bulletin/i18n";
import {
  applyPluginOverrides,
  createCompileCache,
  createTemplateEngine,
  type PluginFragment,
  renderThemeTemplate,
} from "./index.ts";
import { buildTheme } from "./theme-fixtures.ts";

const runtime = { translate: createServerT("en"), hooks: {} };

function fragment(name: string, body: string, pluginId = "hide-post-count"): PluginFragment {
  return { name, body, kind: "override", pluginId };
}

describe("plugin template overrides", () => {
  test("prepends the plugin's version and keeps the theme as fallback", () => {
    const theme = buildTheme([{ name: "child", templates: { page: "<p>theme</p>" } }]);
    const overridden = applyPluginOverrides(theme, [fragment("page", "<p>plugin</p>")]);

    expect(overridden.templates.get("page")?.map((template) => template.body)).toEqual([
      "<p>plugin</p>",
      "<p>theme</p>",
    ]);
    expect(overridden.templates.get("page")?.[0]?.themeId).toBe("plugin:hide-post-count");
  });

  test("leaves the theme untouched when there are no overrides", () => {
    const theme = buildTheme([{ name: "child", templates: { page: "<p>theme</p>" } }]);
    expect(applyPluginOverrides(theme, [])).toBe(theme);
  });
});

describe("hide-post-count scenario", () => {
  const theme = buildTheme([
    {
      name: "child",
      templates: {
        post: '<article data-post>{{ body }}{% hook "post.userbar" %}</article>',
      },
    },
  ]);
  const engine = createTemplateEngine({ islands: {} });
  const viewModel = { body: "<p>Hello</p>", postCount: 42 };

  function renderWith(hooks: Readonly<Record<string, string>>, generation: number) {
    const compiled = createCompileCache(engine).compile(theme, generation);
    return renderThemeTemplate({
      engine,
      compiled,
      name: "post",
      viewModel,
      runtime: { ...runtime, hooks },
    });
  }

  test("shows the stored post count without the plugin", async () => {
    const rendered = await renderWith(
      { "post.userbar": "<span data-post-count>{{ postCount }}</span>" },
      1,
    );

    expect(rendered.html).toContain("42");
    expect(viewModel.postCount).toBe(42);
  });

  test("a plugin fragment hides the count without changing stored data", async () => {
    const rendered = await renderWith({ "post.userbar": "<span data-no-count></span>" }, 2);

    expect(rendered.html).not.toContain("42");
    expect(rendered.html).toContain("data-no-count");
    expect(viewModel.postCount).toBe(42);
  });

  test("toggling the plugin bumps the compile-cache variant", async () => {
    const cache = createCompileCache(engine);
    const before = cache.compile(theme, 1);
    const after = cache.compile(theme, 2);

    expect(before.key).not.toBe(after.key);
    expect(cache.size).toBe(2);
  });
});
