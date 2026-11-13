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

export async function publishPluginFragments(
  sql: SQL,
  manifest: PluginManifest,
  logger: Logger,
): Promise<PublishResult> {
  const wanted = manifest.templateFragments.map((fragment) => ({
    name: fragment.name,
    body: fragment.body,
    kind: fragment.kind,
  }));

  // The generation bump, the copy of every other plugin's fragments and this plugin's new
  // fragment set are one transaction: a crash must not leave a generation that silently
  // loses hooks or keeps removed ones (ADR 0006, 0009).
  return sql.begin(async (transaction) => {
    // Serialise concurrent publishers: two plugin hosts must not build the same generation
    // from different snapshots.
    const generationRows = (await transaction`
      SELECT generation FROM core.plugin_generation WHERE id = true FOR UPDATE
    `) as Array<{ generation: number }>;
    const generation = generationRows[0]?.generation ?? 1;
    const existing = (await transaction`
      SELECT name, body, kind
      FROM core.hook_fragments
      WHERE generation = ${generation} AND plugin_id = ${manifest.id}
    `) as Row[];

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
    if (existing.length === 0 && generation === 1) {
      const anyRows = (await transaction`
        SELECT 1 FROM core.hook_fragments WHERE plugin_id = ${manifest.id} LIMIT 1
      `) as unknown[];

      if (anyRows.length === 0) {
        for (const fragment of wanted) {
          await transaction`
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
        return { generation, changed: wanted.length > 0 };
      }
    }

    const next = generation + 1;

    await transaction`
      UPDATE core.plugin_generation
      SET generation = ${next}, updated_at = now()
      WHERE id = true
    `;

    // Carry every other active plugin's fragments into the new generation; otherwise bumping
    // one plugin hides unrelated hooks. The changed plugin's rows are *not* copied, so a
    // fragment the manifest no longer declares disappears with this generation.
    await transaction`
      INSERT INTO core.hook_fragments (generation, name, body, plugin_id, kind)
      SELECT ${next}, name, body, plugin_id, kind
      FROM core.hook_fragments
      WHERE generation = ${generation} AND plugin_id <> ${manifest.id}
      ON CONFLICT DO NOTHING
    `;

    for (const fragment of wanted) {
      await transaction`
        INSERT INTO core.hook_fragments (generation, name, body, plugin_id, kind)
        VALUES (${next}, ${fragment.name}, ${fragment.body}, ${manifest.id}, ${fragment.kind})
        ON CONFLICT (generation, name) DO UPDATE
          SET body = EXCLUDED.body, plugin_id = EXCLUDED.plugin_id, kind = EXCLUDED.kind
      `;
    }

    await transaction`
      DELETE FROM core.hook_fragments WHERE generation < ${next}
    `;

    logger.info("plugin.fragments_published", {
      pluginId: manifest.id,
      generation: next,
      fragments: wanted.length,
    });
    return { generation: next, changed: true };
  });
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
    ...manifest.vetoes.map((veto) => ({
      kind: "veto",
      key: veto.hook,
      definition: { failMode: veto.failMode ?? "open", reasonKey: veto.reasonKey },
    })),
    ...manifest.enrichers.map((enricher) => ({
      kind: "enricher",
      key: enricher.hook,
      definition: { fields: enricher.fields, deps: enricher.deps ?? [] },
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
      plugin_id, name, version, sdk_version, state, enabled, capabilities,
      approved_capabilities, approved_egress_hosts, timings
    ) VALUES (
      ${manifest.id}, ${manifest.name}, ${manifest.version}, ${manifest.sdkVersion},
      'active', true, (${JSON.stringify(manifest.capabilities)}::text)::jsonb,
      (${JSON.stringify(manifest.capabilities)}::text)::jsonb,
      (${JSON.stringify(manifest.egressHosts)}::text)::jsonb,
      '{"activationMs":30}'::jsonb
    )
    ON CONFLICT (plugin_id) DO NOTHING
  `;

  const usedBits = new Set(
    (
      (await sql`
      SELECT (definition->>'bit')::int AS bit FROM core.plugin_registry
      WHERE kind = 'forum_action' AND definition ? 'bit'
    `) as Array<{ bit: number }>
    ).map((row) => Number(row.bit)),
  );

  for (const entry of entries) {
    let definition = entry.definition;

    if (entry.kind === "forum_action") {
      const existing = (await sql`
        SELECT definition FROM core.plugin_registry
        WHERE plugin_id = ${manifest.id} AND kind = 'forum_action' AND key = ${entry.key}
      `) as Array<{ definition: Record<string, unknown> }>;
      let bit =
        typeof existing[0]?.definition.bit === "number" ? existing[0].definition.bit : undefined;

      if (bit === undefined) {
        for (let candidate = 23; candidate <= 30; candidate += 1) {
          if (!usedBits.has(candidate)) {
            bit = candidate;
            usedBits.add(candidate);
            break;
          }
        }
      }

      if (bit === undefined) {
        throw new Error(`No stable permission bit is available for ${entry.key}`);
      }

      definition = { ...(entry.definition as object), bit };
    }

    await sql`
      INSERT INTO core.plugin_registry (plugin_id, kind, key, definition)
      VALUES (${manifest.id}, ${entry.kind}, ${entry.key}, (${JSON.stringify(definition)}::text)::jsonb)
      ON CONFLICT (plugin_id, kind, key) DO UPDATE SET definition = EXCLUDED.definition
    `;
  }

  logger.info("plugin.registry_published", { pluginId: manifest.id, entries: entries.length });
}
