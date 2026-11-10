/**
 * Spike S1 fixtures (ADR 0008). The template bodies live as `.liquid` files next to this
 * package, the base seed writes them into `core.render_spike_*`, and the dev-only
 * `/spike/rendering` route renders them. Task 2.1 replaces this with the default theme under
 * `packages/templates/themes`.
 */

export const SPIKE_ROUTE = "/spike/rendering";
export const SPIKE_TEMPLATE_NAME = "page";
export const SPIKE_HOOK_NAME = "spike.after.counter";

export const SPIKE_THEMES = ["default", "alt"] as const;
export type SpikeThemeName = (typeof SPIKE_THEMES)[number];

export const SPIKE_PLUGIN_GENERATIONS = [1, 2] as const;

export interface SpikeThemeFixture {
  readonly theme: SpikeThemeName;
  readonly version: number;
  readonly template: string;
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
 * Reads the fixture bodies. The second theme proves that a theme switch produces a distinct
 * cache entry; generation 2 stands in for an installed plugin.
 */
export async function loadSpikeFixtures(): Promise<{
  readonly themes: readonly SpikeThemeFixture[];
  readonly hooks: readonly SpikeHookFixture[];
}> {
  const [defaultTemplate, altTemplate, hook1, hook2] = await Promise.all([
    readFixture("page.default.liquid"),
    readFixture("page.alt.liquid"),
    readFixture("hook.generation-1.liquid"),
    readFixture("hook.generation-2.liquid"),
  ]);

  return {
    themes: [
      { theme: "default", version: 1, template: defaultTemplate },
      { theme: "alt", version: 1, template: altTemplate },
    ],
    hooks: [
      { generation: 1, hook: SPIKE_HOOK_NAME, body: hook1 },
      { generation: 2, hook: SPIKE_HOOK_NAME, body: hook2 },
    ],
  };
}
