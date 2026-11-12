import type { ThemeTokens } from "@bulletin/templates";
import {
  DEFAULT_THEME_NAME,
  DEFAULT_THEME_VERSION,
  formatTemplateIssues,
  HOOK_NAMES,
  loadDefaultThemeTemplates,
  loadDefaultThemeTokens,
  loadDemoHookFragments,
  validateTemplateMarkup,
} from "@bulletin/templates";
import type { SQL } from "bun";
import type { SeedModule } from "./framework.ts";

/** The plugin generation the demo route renders hook fragments for (ADR 0009). */
export const SEEDED_PLUGIN_GENERATION = 1;

export interface DefaultThemeSource {
  /** Every template the repository version defines, keyed by template name. */
  readonly templates: Readonly<Record<string, string>>;
  /** The repository token sets; omitted by injected test sources that only change templates. */
  readonly tokens?: ThemeTokens;
  /** Overrides the computed hash; tests use it to simulate an older or newer repo copy. */
  readonly hash?: string;
}

export interface DefaultThemeSyncResult {
  readonly changed: boolean;
  readonly version: number;
  readonly hash: string;
}

/**
 * The repository hash the DB copy records (ADR 0008). Template names and bodies are sorted
 * into one canonical string, so reordering files or touching mtimes never triggers a sync.
 */
export function defaultThemeSourceHash(
  templates: Readonly<Record<string, string>>,
  tokens?: ThemeTokens,
): string {
  const canonical = Object.keys(templates)
    .sort()
    .map((name) => [name, templates[name]]);

  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        name: DEFAULT_THEME_NAME,
        version: DEFAULT_THEME_VERSION,
        templates: canonical,
        ...(tokens === undefined ? {} : { tokens }),
      }),
    )
    .digest("hex");
}

async function repositorySource(): Promise<DefaultThemeSource> {
  const [templates, tokens] = await Promise.all([
    loadDefaultThemeTemplates(),
    loadDefaultThemeTokens(),
  ]);

  return { templates, tokens };
}

function validate(templates: Readonly<Record<string, string>>): void {
  for (const [name, body] of Object.entries(templates)) {
    const validation = validateTemplateMarkup(body);

    if (!validation.ok) {
      throw new Error(
        `Default theme template ${name} failed validation: ${formatTemplateIssues(validation.issues)}`,
      );
    }
  }
}

interface ExistingTheme {
  readonly id: string;
  readonly version: number;
  readonly source_hash: string | null;
  readonly source: string;
  readonly is_active: boolean;
}

interface ExistingTemplate {
  readonly name: string;
}

/**
 * Installs or updates the bundled default theme from repository files (ADR 0008).
 *
 * The DB copy is compared by hash, not by template body: admins cannot edit the default
 * theme, and comparing hashes avoids rewriting rows on every service start. Only when the
 * repository changes does the sync replace bodies, bump the theme version (which invalidates
 * the compile and fragment caches) and remove templates that no longer exist.
 *
 * It runs under a transaction-scoped advisory lock because every service calls it at startup.
 */
export async function syncDefaultTheme(
  sql: SQL,
  source?: DefaultThemeSource,
): Promise<DefaultThemeSyncResult> {
  const resolved = source ?? (await repositorySource());

  // A nested `begin` is invalid inside the seed's transaction, so the public entry point
  // owns the transaction and the seed calls the transaction-scoped helper directly.
  return sql.begin((tx) => syncDefaultThemeInTransaction(tx, resolved));
}

export async function syncDefaultThemeInTransaction(
  tx: SQL,
  source?: DefaultThemeSource,
): Promise<DefaultThemeSyncResult> {
  const resolved = source ?? (await repositorySource());
  validate(resolved.templates);
  const hash = resolved.hash ?? defaultThemeSourceHash(resolved.templates, resolved.tokens);
  const names = Object.keys(resolved.templates).sort();

  await tx`SELECT pg_advisory_xact_lock(hashtext('bulletin.theme_sync'))`;

  const existing = (await tx`
    SELECT id::text AS id, version, source_hash
    FROM core.themes
    WHERE name = ${DEFAULT_THEME_NAME}
  `) as ExistingTheme[];
  const theme = existing[0];

  if (theme === undefined) {
    const [created] = (await tx`
      INSERT INTO core.themes (name, version, source_hash, source, is_active)
      VALUES (${DEFAULT_THEME_NAME}, ${DEFAULT_THEME_VERSION}, ${hash}, 'core', true)
      RETURNING id::text AS id, version
    `) as Array<{ id: string; version: number }>;

    if (created === undefined) {
      throw new Error("Could not install the default theme");
    }

    for (const name of names) {
      await tx`
        INSERT INTO core.theme_templates (theme_id, name, body)
        VALUES (${created.id}, ${name}, ${resolved.templates[name] ?? ""})
      `;
    }

    await syncTokens(tx, created.id, resolved.tokens);

    return { changed: true, version: created.version, hash };
  }

  if (theme.source_hash === hash) {
    if (theme.source !== "core" || !theme.is_active) {
      await tx`
        UPDATE core.themes SET source = 'core', is_active = true, updated_at = now()
        WHERE id = ${theme.id}
      `;
    }

    return { changed: false, version: theme.version, hash };
  }

  const [updated] = (await tx`
    UPDATE core.themes
    SET source_hash = ${hash}, source = 'core', is_active = true,
      version = version + 1, updated_at = now()
    WHERE id = ${theme.id}
    RETURNING version
  `) as Array<{ version: number }>;

  if (updated === undefined) {
    throw new Error("Could not update the default theme");
  }

  for (const name of names) {
    await tx`
      INSERT INTO core.theme_templates (theme_id, name, body)
      VALUES (${theme.id}, ${name}, ${resolved.templates[name] ?? ""})
      ON CONFLICT (theme_id, name) DO UPDATE
      SET body = EXCLUDED.body,
        version = core.theme_templates.version
          + CASE WHEN core.theme_templates.body IS DISTINCT FROM EXCLUDED.body THEN 1 ELSE 0 END,
        updated_at = now()
    `;
  }

  const stored = (await tx`
    SELECT name FROM core.theme_templates WHERE theme_id = ${theme.id}
  `) as ExistingTemplate[];

  for (const template of stored) {
    if (!names.includes(template.name)) {
      await tx`
        DELETE FROM core.theme_templates
        WHERE theme_id = ${theme.id} AND name = ${template.name}
      `;
    }
  }

  await syncTokens(tx, theme.id, resolved.tokens);
  await recordVersionHistory(tx, theme.id);

  return { changed: true, version: updated.version, hash };
}

/** Writes the repository's light/dark token sets over the default theme's rows. */
async function syncTokens(
  tx: SQL,
  themeId: string,
  tokens: ThemeTokens | undefined,
): Promise<void> {
  if (tokens === undefined) {
    return;
  }

  for (const scheme of ["light", "dark"] as const) {
    await tx`
      INSERT INTO core.theme_tokens (theme_id, scheme, tokens, updated_at)
      VALUES (${themeId}, ${scheme}, ${tokens[scheme]}::jsonb, now())
      ON CONFLICT (theme_id, scheme) DO UPDATE
      SET tokens = EXCLUDED.tokens, updated_at = now()
    `;
  }
}

/** Makes every current template row restorable, including the repository's first install. */
async function recordVersionHistory(tx: SQL, themeId: string): Promise<void> {
  await tx`
    INSERT INTO core.theme_template_versions (theme_id, name, version, body)
    SELECT theme_id, name, version, body
    FROM core.theme_templates
    WHERE theme_id = ${themeId}
    ON CONFLICT (theme_id, name, version) DO NOTHING
  `;
}

/**
 * Installs the default theme and its demo hook fragments. The seed runs once on an empty
 * database; `syncDefaultTheme` also runs at every service start so an existing volume picks
 * up new theme files after an upgrade.
 */
export const themesSeedModule: SeedModule = {
  name: "themes",
  async run({ sql }) {
    await syncDefaultThemeInTransaction(sql);

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
