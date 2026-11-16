import { loadDefaultThemeTemplates } from "@bulletin/templates";
import type { SeedModule } from "./framework.ts";

/** A demo child footer: the default footer plus a variant marker the E2E themes look for. */
async function demoFooter(variant: string): Promise<string> {
  const { footer } = await loadDefaultThemeTemplates();

  if (footer === undefined || !footer.includes("data-theme-footer")) {
    throw new Error("The default footer must carry data-theme-footer");
  }

  return footer.replace("data-theme-footer", `data-theme-footer data-theme-variant="${variant}"`);
}

/**
 * Lounge: a softer card layout over the default templates. Forums on the index become cards;
 * everything else keeps the default structure, so it only needs tokens and a little CSS.
 */
const LOUNGE_CSS = `
.bl-board-category:not(.bl-topic-table) { border: 0; background: none; overflow: visible; }
.bl-main .bl-board-category:not(.bl-topic-table) { margin-inline: 0; }
.bl-board-category:not(.bl-topic-table) .bl-board-category__header { padding-inline: 0; border: 0; background: none; }
.bl-board-category:not(.bl-topic-table) .bl-forum-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); gap: var(--bl-s4); }
.bl-board-category:not(.bl-topic-table) .bl-forum { grid-template-columns: 2.25rem minmax(0, 1fr); align-content: start; padding: var(--bl-s4); border: 1px solid var(--bl-border); border-radius: var(--bl-radius-large); background: var(--bl-surface); }
.bl-board-category:not(.bl-topic-table) .bl-forum + .bl-forum { border-top: 1px solid var(--bl-border); }
.bl-board-category:not(.bl-topic-table) .bl-forum__stats,
.bl-board-category:not(.bl-topic-table) .bl-forum__last { grid-column: 2; justify-self: start; text-align: start; }
.bl-board-category:not(.bl-topic-table) .bl-forum-columns { display: none; }
.bl-post { border-radius: var(--bl-radius-large); }
.bl-footer { border-block-start-color: var(--bl-accent-border); }
`;

/**
 * A second theme, a VIP-only theme and their distinct tokens (task 5.2). The marketplace
 * theme package is served by `mocks/marketplace`, not seeded into the database.
 */
export const demoThemesSeedModule: SeedModule = {
  name: "demo-themes",
  dependsOn: ["themes", "groups"],
  async run({ sql }) {
    const [defaultTheme] = (await sql`
      SELECT id::text AS id FROM core.themes WHERE name = 'default'
    `) as Array<{ id: string }>;

    if (defaultTheme === undefined) {
      throw new Error("The default theme must exist before the demo themes");
    }

    const [sunset] = (await sql`
      INSERT INTO core.themes (name, parent_id, version, source, is_active, description)
      VALUES (
        'sunset', ${defaultTheme.id}, 1, 'custom', true,
        'A warm evening palette that inherits the default theme.'
      )
      ON CONFLICT (name) DO UPDATE
        SET parent_id = EXCLUDED.parent_id, description = EXCLUDED.description
      RETURNING id::text AS id
    `) as Array<{ id: string }>;
    const [vip] = (await sql`
      INSERT INTO core.themes (name, parent_id, version, source, is_active, description)
      VALUES (
        'vip-gold', ${defaultTheme.id}, 1, 'custom', true,
        'A gold theme available only to VIP members.'
      )
      ON CONFLICT (name) DO UPDATE
        SET parent_id = EXCLUDED.parent_id, description = EXCLUDED.description
      RETURNING id::text AS id
    `) as Array<{ id: string }>;

    const [lounge] = (await sql`
      INSERT INTO core.themes (name, parent_id, version, source, is_active, description)
      VALUES (
        'lounge', ${defaultTheme.id}, 1, 'custom', true,
        'A relaxed card layout with softer corners and a teal accent.'
      )
      ON CONFLICT (name) DO UPDATE
        SET parent_id = EXCLUDED.parent_id, description = EXCLUDED.description
      RETURNING id::text AS id
    `) as Array<{ id: string }>;

    if (sunset === undefined || vip === undefined || lounge === undefined) {
      throw new Error("Could not seed the demo themes");
    }

    for (const [themeId, footer] of [
      [sunset.id, await demoFooter("sunset")],
      [vip.id, await demoFooter("vip")],
      [lounge.id, await demoFooter("lounge")],
    ] as const) {
      const [template] = (await sql`
        INSERT INTO core.theme_templates (theme_id, name, body, version)
        VALUES (${themeId}, 'footer', ${footer}, 1)
        ON CONFLICT (theme_id, name) DO UPDATE
          SET body = EXCLUDED.body,
              version = core.theme_templates.version + 1,
              updated_at = now()
        RETURNING version
      `) as Array<{ version: number }>;

      await sql`
        INSERT INTO core.theme_template_versions (theme_id, name, version, body)
        VALUES (${themeId}, 'footer', ${template?.version ?? 1}, ${footer})
        ON CONFLICT (theme_id, name, version) DO NOTHING
      `;
    }

    await sql`
      INSERT INTO core.theme_tokens (theme_id, scheme, tokens)
      VALUES (${sunset.id}, 'light', ${{ accent: "#5b3fa8" }}::jsonb)
      ON CONFLICT (theme_id, scheme) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = now()
    `;
    await sql`
      INSERT INTO core.theme_tokens (theme_id, scheme, tokens)
      VALUES (${sunset.id}, 'dark', ${{ accent: "#c4b5fd" }}::jsonb)
      ON CONFLICT (theme_id, scheme) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = now()
    `;
    await sql`
      INSERT INTO core.theme_tokens (theme_id, scheme, tokens)
      VALUES (${vip.id}, 'light', ${{ accent: "#8a6500" }}::jsonb)
      ON CONFLICT (theme_id, scheme) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = now()
    `;
    await sql`
      INSERT INTO core.theme_tokens (theme_id, scheme, tokens)
      VALUES (${vip.id}, 'dark', ${{ accent: "#f2cf6b" }}::jsonb)
      ON CONFLICT (theme_id, scheme) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = now()
    `;

    await sql`
      INSERT INTO core.theme_tokens (theme_id, scheme, tokens)
      VALUES (${lounge.id}, 'light', ${{
        bg: "#f5f3ef",
        accent: "#0f766e",
        "accent-hover": "#115e59",
        "accent-soft": "#e7f4f1",
        "accent-border": "#a9d9d0",
        focus: "#0f766e",
        radius: "10px",
        "radius-small": "6px",
        "radius-large": "14px",
      }}::jsonb)
      ON CONFLICT (theme_id, scheme) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = now()
    `;
    await sql`
      INSERT INTO core.theme_tokens (theme_id, scheme, tokens)
      VALUES (${lounge.id}, 'dark', ${{
        bg: "#0f1312",
        accent: "#5eead4",
        "accent-hover": "#99f6e4",
        "accent-soft": "#11231f",
        "accent-border": "#1e4b44",
        focus: "#5eead4",
        radius: "10px",
        "radius-small": "6px",
        "radius-large": "14px",
      }}::jsonb)
      ON CONFLICT (theme_id, scheme) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = now()
    `;
    await sql`
      INSERT INTO core.theme_css (theme_id, css)
      VALUES (${lounge.id}, ${LOUNGE_CSS})
      ON CONFLICT (theme_id) DO UPDATE SET css = EXCLUDED.css, updated_at = now()
    `;

    await sql`
      INSERT INTO core.theme_css (theme_id, css)
      VALUES (${sunset.id}, '.bl-footer { border-block-start-color: var(--bl-accent); }')
      ON CONFLICT (theme_id) DO UPDATE SET css = EXCLUDED.css, updated_at = now()
    `;
    await sql`
      INSERT INTO core.theme_css (theme_id, css)
      VALUES (${vip.id}, '.bl-footer { border-block-start-width: 3px; }')
      ON CONFLICT (theme_id) DO UPDATE SET css = EXCLUDED.css, updated_at = now()
    `;

    await sql`DELETE FROM core.theme_allowed_groups WHERE theme_id = ${vip.id}`;
    await sql`
      INSERT INTO core.theme_allowed_groups (theme_id, group_id)
      SELECT ${vip.id}, id FROM core.groups WHERE key = 'vip'
    `;
  },
};
