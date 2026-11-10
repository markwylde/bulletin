import { loadSpikeFixtures } from "@bulletin/templates";
import type { SeedModule } from "./framework.ts";

/**
 * Spike S1 (ADR 0008): the prototype themes and the plugin-style hook fragments the dev-only
 * `/spike/rendering` route reads. `alt` is a child of `default` and overrides only `page`, so
 * the route proves parent fallback. Task 8.2 replaces this with the real theme seed.
 */
export const renderSpikeSeedModule: SeedModule = {
  name: "render-spike",
  async run({ sql }) {
    const { themes, hooks } = await loadSpikeFixtures();

    for (const theme of themes) {
      await sql`
        INSERT INTO core.themes (name, version)
        VALUES (${theme.name}, ${theme.version})
        ON CONFLICT (name) DO UPDATE SET version = EXCLUDED.version
      `;
    }

    for (const theme of themes) {
      if (theme.parent === null) {
        continue;
      }

      await sql`
        UPDATE core.themes
        SET parent_id = (SELECT parent.id FROM core.themes AS parent WHERE parent.name = ${theme.parent})
        WHERE name = ${theme.name}
      `;
    }

    for (const theme of themes) {
      for (const [name, body] of Object.entries(theme.templates)) {
        await sql`
          INSERT INTO core.theme_templates (theme_id, name, body)
          SELECT id, ${name}, ${body} FROM core.themes WHERE name = ${theme.name}
          ON CONFLICT (theme_id, name) DO UPDATE SET body = EXCLUDED.body
        `;
      }
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
