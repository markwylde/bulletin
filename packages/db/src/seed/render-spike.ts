import { loadSpikeFixtures, SPIKE_TEMPLATE_NAME } from "@bulletin/templates";
import type { SeedModule } from "./framework.ts";

/**
 * Spike S1 (ADR 0008): the two prototype themes and the plugin-style hook fragments the
 * dev-only `/spike/rendering` route reads. Task 8.2 replaces this with the real theme seed.
 */
export const renderSpikeSeedModule: SeedModule = {
  name: "render-spike",
  async run({ sql }) {
    const { themes, hooks } = await loadSpikeFixtures();

    for (const theme of themes) {
      await sql`
        INSERT INTO core.render_spike_themes (name, version)
        VALUES (${theme.theme}, ${theme.version})
        ON CONFLICT (name) DO UPDATE SET version = EXCLUDED.version
      `;
      await sql`
        INSERT INTO core.render_spike_templates (theme_name, name, body)
        VALUES (${theme.theme}, ${SPIKE_TEMPLATE_NAME}, ${theme.template})
        ON CONFLICT (theme_name, name) DO UPDATE SET body = EXCLUDED.body
      `;
    }

    for (const hook of hooks) {
      await sql`
        INSERT INTO core.render_spike_hooks (generation, name, body)
        VALUES (${hook.generation}, ${hook.hook}, ${hook.body})
        ON CONFLICT (generation, name) DO UPDATE SET body = EXCLUDED.body
      `;
    }
  },
};
