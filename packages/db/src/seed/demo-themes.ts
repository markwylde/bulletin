import type { SeedModule } from "./framework.ts";

const SUNSET_FOOTER = `<footer class="bl-footer" data-theme-footer data-theme-variant="sunset">
  <p class="bl-footer__text">{% t "theme.footer" %} <span data-board-year>{{ year }}</span></p>
</footer>
`;

const VIP_FOOTER = `<footer class="bl-footer" data-theme-footer data-theme-variant="vip">
  <p class="bl-footer__text">{% t "theme.footer" %} <span data-board-year>{{ year }}</span></p>
</footer>
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

    if (sunset === undefined || vip === undefined) {
      throw new Error("Could not seed the demo themes");
    }

    for (const [themeId, footer] of [
      [sunset.id, SUNSET_FOOTER],
      [vip.id, VIP_FOOTER],
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
      VALUES (${sunset.id}, 'light', ${JSON.stringify({ accent: "#5b3fa8" })}::jsonb)
      ON CONFLICT (theme_id, scheme) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = now()
    `;
    await sql`
      INSERT INTO core.theme_tokens (theme_id, scheme, tokens)
      VALUES (${sunset.id}, 'dark', ${JSON.stringify({ accent: "#c4b5fd" })}::jsonb)
      ON CONFLICT (theme_id, scheme) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = now()
    `;
    await sql`
      INSERT INTO core.theme_tokens (theme_id, scheme, tokens)
      VALUES (${vip.id}, 'light', ${JSON.stringify({ accent: "#8a6500" })}::jsonb)
      ON CONFLICT (theme_id, scheme) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = now()
    `;
    await sql`
      INSERT INTO core.theme_tokens (theme_id, scheme, tokens)
      VALUES (${vip.id}, 'dark', ${JSON.stringify({ accent: "#f2cf6b" })}::jsonb)
      ON CONFLICT (theme_id, scheme) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = now()
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
