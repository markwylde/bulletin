import type { Logger } from "@bulletin/config";
import type { PluginManifest } from "@bulletin/plugin-sdk/manifest";
import type { SQL } from "bun";

/**
 * Publishes a plugin manifest's template fragments into `core.hook_fragments` at the current
 * pluginsGeneration. A changed bundle gets a new generation, which invalidates compiled
 * templates and cached pages (ADR 0006, 0009). Lifecycle calls this on install/upgrade; the
 * demo host calls it at startup.
 */

export interface PublishResult {
  readonly generation: number;
  readonly changed: boolean;
}

interface Row {
  readonly name: string;
  readonly body: string;
  readonly kind: string;
}

async function currentGeneration(sql: SQL): Promise<number> {
  const rows = (await sql`
    SELECT generation FROM core.plugin_generation WHERE id = true
  `) as Array<{ generation: number }>;

  return rows[0]?.generation ?? 1;
}

export async function publishPluginFragments(
  sql: SQL,
  manifest: PluginManifest,
  logger: Logger,
): Promise<PublishResult> {
  const generation = await currentGeneration(sql);
  const existing = (await sql`
    SELECT name, body, kind
    FROM core.hook_fragments
    WHERE generation = ${generation} AND plugin_id = ${manifest.id}
  `) as Row[];
  const wanted = manifest.templateFragments.map((fragment) => ({
    name: fragment.name,
    body: fragment.body,
    kind: fragment.kind,
  }));

  if (wanted.length === 0) {
    return { generation, changed: false };
  }

  const same =
    existing.length === wanted.length &&
    wanted.every((fragment) => {
      const row = existing.find((candidate) => candidate.name === fragment.name);
      return row?.body === fragment.body && row.kind === fragment.kind;
    });

  if (same) {
    return { generation, changed: false };
  }

  // First start of a fresh board: sample seed fragments already live at generation 1, so the
  // demo host joins that generation instead of bumping and hiding them.
  if (existing.length === 0) {
    const anyRows = (await sql`
      SELECT 1 FROM core.hook_fragments WHERE plugin_id = ${manifest.id} LIMIT 1
    `) as unknown[];

    if (anyRows.length === 0 && generation === 1) {
      for (const fragment of wanted) {
        await sql`
          INSERT INTO core.hook_fragments (generation, name, body, plugin_id, kind)
          VALUES (${generation}, ${fragment.name}, ${fragment.body}, ${manifest.id}, ${fragment.kind})
          ON CONFLICT DO NOTHING
        `;
      }

      logger.info("plugin.fragments_published", {
        pluginId: manifest.id,
        generation,
        fragments: wanted.length,
      });
      return { generation, changed: true };
    }
  }

  const next = generation + 1;

  await sql`
    UPDATE core.plugin_generation
    SET generation = ${next}, updated_at = now()
    WHERE id = true
  `;

  // Carry every other active plugin's fragments into the new generation before adding the
  // changed plugin's rows; otherwise bumping one plugin hides unrelated hooks.
  await sql`
    INSERT INTO core.hook_fragments (generation, name, body, plugin_id, kind)
    SELECT ${next}, name, body, plugin_id, kind
    FROM core.hook_fragments
    WHERE generation = ${generation}
    ON CONFLICT DO NOTHING
  `;

  for (const fragment of wanted) {
    await sql`
      INSERT INTO core.hook_fragments (generation, name, body, plugin_id, kind)
      VALUES (${next}, ${fragment.name}, ${fragment.body}, ${manifest.id}, ${fragment.kind})
      ON CONFLICT (generation, name) DO UPDATE
        SET body = EXCLUDED.body, plugin_id = EXCLUDED.plugin_id, kind = EXCLUDED.kind
    `;
  }

  await sql`
    DELETE FROM core.hook_fragments WHERE generation < ${next}
  `;

  logger.info("plugin.fragments_published", {
    pluginId: manifest.id,
    generation: next,
    fragments: wanted.length,
  });
  return { generation: next, changed: true };
}

/** Writes registry entries the staff app reads: settings, forum actions, flags, routes, jobs. */
export async function publishPluginRegistry(
  sql: SQL,
  manifest: PluginManifest,
  logger: Logger,
): Promise<void> {
  const entries: Array<{ kind: string; key: string; definition: unknown }> = [
    ...manifest.forumActions.map((key) => ({
      kind: "forum_action",
      key,
      definition: { labelKey: `plugin.${manifest.id}.forumAction.${key}` },
    })),
    ...manifest.flags.map((key) => ({
      kind: "flag",
      key: `plugin.${manifest.id}.${key}`,
      definition: { affectsRender: true },
    })),
    ...manifest.templateFragments.map((fragment) => ({
      kind: "fragment",
      key: fragment.name,
      definition: { kind: fragment.kind, deps: fragment.deps ?? [] },
    })),
    ...manifest.routes.map((route) => ({
      kind: "route",
      key: route.path,
      definition: { kind: route.kind },
    })),
    ...manifest.jobs.map((job) => ({
      kind: "job",
      key: job.name,
      definition: job.schedule === undefined ? {} : { schedule: job.schedule },
    })),
    ...(manifest.settings === null
      ? []
      : [{ kind: "setting", key: manifest.id, definition: manifest.settings }]),
  ];

  // The local demo plugin is visible in the staff manager without a marketplace install.
  await sql`
    INSERT INTO core.plugins (
      plugin_id, name, version, sdk_version, state, enabled, capabilities, timings
    ) VALUES (
      ${manifest.id}, ${manifest.name}, ${manifest.version}, ${manifest.sdkVersion},
      'active', true, (${JSON.stringify(manifest.capabilities)}::text)::jsonb,
      '{"activationMs":30}'::jsonb
    )
    ON CONFLICT (plugin_id) DO NOTHING
  `;

  for (const entry of entries) {
    await sql`
      INSERT INTO core.plugin_registry (plugin_id, kind, key, definition)
      VALUES (${manifest.id}, ${entry.kind}, ${entry.key}, (${JSON.stringify(entry.definition)}::text)::jsonb)
      ON CONFLICT (plugin_id, kind, key) DO UPDATE SET definition = EXCLUDED.definition
    `;
  }

  logger.info("plugin.registry_published", { pluginId: manifest.id, entries: entries.length });
}
