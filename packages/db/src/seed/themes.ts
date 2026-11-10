import {
  DEFAULT_THEME_NAME,
  DEFAULT_THEME_VERSION,
  formatTemplateIssues,
  HOOK_NAMES,
  loadDefaultThemeTemplates,
  loadDemoHookFragments,
  validateTemplateMarkup,
} from "@bulletin/templates";
import type { SeedModule } from "./framework.ts";

/** The plugin generation the demo route renders hook fragments for (ADR 0009). */
export const SEEDED_PLUGIN_GENERATION = 1;

/**
 * Installs the default theme from the repository files (ADR 0008). Task 8.2 verifies the
 * repo-to-DB sync; this module is the deterministic seed the demo and personal routes use.
 */
export const themesSeedModule: SeedModule = {
  name: "themes",
  async run({ sql }) {
    const templates = await loadDefaultThemeTemplates();

    for (const [name, body] of Object.entries(templates)) {
      const validation = validateTemplateMarkup(body);

      if (!validation.ok) {
        throw new Error(
          `Default theme template ${name} failed validation: ${formatTemplateIssues(validation.issues)}`,
        );
      }
    }

    const [theme] = (await sql`
      INSERT INTO core.themes (name, version)
      VALUES (${DEFAULT_THEME_NAME}, ${DEFAULT_THEME_VERSION})
      ON CONFLICT (name) DO UPDATE SET version = EXCLUDED.version
      RETURNING id
    `) as Array<{ id: string }>;

    if (theme === undefined) {
      throw new Error("Could not seed the default theme");
    }

    for (const [name, body] of Object.entries(templates)) {
      await sql`
        INSERT INTO core.theme_templates (theme_id, name, body)
        VALUES (${theme.id}, ${name}, ${body})
        ON CONFLICT (theme_id, name) DO UPDATE SET body = EXCLUDED.body
      `;
    }

    const hooks = await loadDemoHookFragments();

    for (const name of Object.keys(hooks)) {
      if (!HOOK_NAMES.includes(name)) {
        throw new Error(`Demo hook fragment ${name} is not in the hook registry`);
      }
    }

    for (const [name, body] of Object.entries(hooks)) {
      await sql`
        INSERT INTO core.hook_fragments (generation, name, body)
        VALUES (${SEEDED_PLUGIN_GENERATION}, ${name}, ${body})
        ON CONFLICT (generation, name) DO UPDATE SET body = EXCLUDED.body
      `;
    }
  },
};
