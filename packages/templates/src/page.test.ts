import { describe, expect, test } from "bun:test";
import { createServerT } from "@bulletin/i18n";
import {
  createCompileCache,
  createTemplateEngine,
  renderThemePage,
  type TemplateRuntime,
} from "./index.ts";
import { buildTheme } from "./theme-fixtures.ts";

const runtime: TemplateRuntime = { translate: createServerT("en"), hooks: {} };

function compiled() {
  return createCompileCache(createTemplateEngine({ islands: {} })).compile(
    buildTheme([
      {
        name: "default",
        templates: {
          header: "<header>{{ boardName }}</header>",
          footer: "<footer>{{ year }}</footer>",
          page: "<main>{{ header }}<h1>{{ title }}</h1>{{ footer }}</main>",
          error: "<main>{{ header }}<p>{{ message }}</p>{{ footer }}</main>",
        },
      },
    ]),
    1,
  );
}

describe("renderThemePage", () => {
  test("renders regions first and exposes them to the page as safe HTML", async () => {
    const engine = createTemplateEngine({ islands: {} });
    const page = await renderThemePage({
      engine,
      compiled: compiled(),
      name: "page",
      viewModel: { title: "Demo" },
      runtime,
      regions: [
        { name: "header", viewModel: { boardName: "Bulletin" } },
        { name: "footer", viewModel: { year: 2026 } },
      ],
    });

    expect(page.html).toBe(
      "<main><header>Bulletin</header><h1>Demo</h1><footer>2026</footer></main>",
    );
    expect(Object.keys(page.regions).sort()).toEqual(["footer", "header"]);
    expect(page.violations).toEqual([]);
  });

  test("uses the parent chain for a region the theme overrides only in the parent", async () => {
    const theme = buildTheme([
      { name: "child", templates: { page: "{{ header }}<p>child</p>" } },
      { name: "parent", templates: { header: "<header>parent header</header>" } },
    ]);
    const engine = createTemplateEngine({ islands: {} });
    const page = await renderThemePage({
      engine,
      compiled: createCompileCache(engine).compile(theme, 1),
      name: "page",
      viewModel: {},
      runtime,
      regions: [{ name: "header", viewModel: {} }],
    });

    expect(page.html).toBe("<header>parent header</header><p>child</p>");
  });

  test("exposes a region under a different page variable when asked", async () => {
    const engine = createTemplateEngine({ islands: {} });
    const page = await renderThemePage({
      engine,
      compiled: createCompileCache(engine).compile(
        buildTheme([
          {
            name: "default",
            templates: { empty: "<p>{{ title }}</p>", page: "{{ emptyState }}" },
          },
        ]),
        1,
      ),
      name: "page",
      viewModel: {},
      runtime,
      regions: [{ name: "empty", key: "emptyState", viewModel: { title: "Nothing" } }],
    });

    expect(page.html).toBe("<p>Nothing</p>");
  });

  test("renders a page that has no regions", async () => {
    const engine = createTemplateEngine({ islands: {} });
    const page = await renderThemePage({
      engine,
      compiled: createCompileCache(engine).compile(
        buildTheme([{ name: "default", templates: { page: "<p>plain</p>" } }]),
        1,
      ),
      name: "page",
      viewModel: {},
      runtime,
    });

    expect(page.html).toBe("<p>plain</p>");
    expect(page.regions).toEqual({});
  });

  test("reports a missing page template", async () => {
    const engine = createTemplateEngine({ islands: {} });

    await expect(
      renderThemePage({
        engine,
        compiled: compiled(),
        name: "missing",
        viewModel: {},
        runtime,
      }),
    ).rejects.toThrow("could not be rendered");
  });
});
