/**
 * Spike S1 fixtures (ADR 0008). The template bodies live as `.liquid` files next to this
 * package, the base seed writes them into `core.themes`/`core.theme_templates`, and the
 * dev-only `/spike/rendering` route renders them. Task 8.2 replaces them with the default
 * theme under `packages/templates/themes`.
 */

export const SPIKE_ROUTE = "/spike/rendering";
export const SPIKE_PAGE_TEMPLATE = "page";
export const SPIKE_FOOTER_TEMPLATE = "footer";
export const SPIKE_HOOK_NAME = "spike.after.counter";

export const SPIKE_THEMES = ["default", "alt"] as const;
export type SpikeThemeName = (typeof SPIKE_THEMES)[number];

export const SPIKE_PLUGIN_GENERATIONS = [1, 2] as const;

export interface SpikeThemeFixture {
  readonly name: SpikeThemeName;
  readonly parent: SpikeThemeName | null;
  readonly version: number;
  readonly templates: Readonly<Record<string, string>>;
}

export interface SpikeHookFixture {
  readonly generation: number;
  readonly hook: string;
  readonly body: string;
}

const TEMPLATES_DIR = new URL("../spike-templates/", import.meta.url);

function readFixture(name: string): Promise<string> {
  return Bun.file(new URL(name, TEMPLATES_DIR)).text();
}

/**
 * Reads the fixture bodies. `alt` is a child of `default` and overrides only `page`, so its
 * footer comes from the parent (ADR 0008 fallback); generation 2 stands in for an installed
 * plugin.
 */
export async function loadSpikeFixtures(): Promise<{
  readonly themes: readonly SpikeThemeFixture[];
  readonly hooks: readonly SpikeHookFixture[];
}> {
  const [defaultPage, altPage, defaultFooter, hook1, hook2] = await Promise.all([
    readFixture("page.default.liquid"),
    readFixture("page.alt.liquid"),
    readFixture("footer.default.liquid"),
    readFixture("hook.generation-1.liquid"),
    readFixture("hook.generation-2.liquid"),
  ]);

  return {
    themes: [
      {
        name: "default",
        parent: null,
        version: 1,
        templates: { [SPIKE_PAGE_TEMPLATE]: defaultPage, [SPIKE_FOOTER_TEMPLATE]: defaultFooter },
      },
      { name: "alt", parent: "default", version: 1, templates: { [SPIKE_PAGE_TEMPLATE]: altPage } },
    ],
    hooks: [
      { generation: 1, hook: SPIKE_HOOK_NAME, body: hook1 },
      { generation: 2, hook: SPIKE_HOOK_NAME, body: hook2 },
    ],
  };
}
