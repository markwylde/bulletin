import { SAMPLE_PLUGINS } from "@bulletin/domain/plugins";
import type { SeedModule } from "./framework.ts";

const SETTING_LABEL = (pluginId: string) => `plugin.${pluginId}.settings.title`;

/** Installs the local sample plugins and their registry rows (ADR 0009, task 6.2). */
export const pluginSeedModule: SeedModule = {
  name: "plugins",
  async run({ sql }) {
    const [generationRow] = (await sql`
      SELECT generation FROM core.plugin_generation WHERE id = true
    `) as Array<{ generation: number }>;
    const generation = generationRow?.generation ?? 1;

    for (const plugin of SAMPLE_PLUGINS) {
      await sql`
        INSERT INTO core.plugins (
          plugin_id, name, version, sdk_version, state, enabled, generation,
          capabilities, personal_data, timings
        ) VALUES (
          ${plugin.id}, ${plugin.name}, ${plugin.version}, ${plugin.sdkVersion},
          ${plugin.state}, ${plugin.state === "active"}, ${generation},
          (${JSON.stringify(plugin.capabilities)}::text)::jsonb,
          (${JSON.stringify(plugin.personalData)}::text)::jsonb,
          '{"activationMs":35}'::jsonb
        )
        ON CONFLICT (plugin_id) DO NOTHING
      `;

      for (const declaration of plugin.personalData) {
        await sql`
          INSERT INTO core.plugin_personal_data (plugin_id, table_name, member_column)
          VALUES (${plugin.id}, ${declaration.table}, ${declaration.memberColumn})
          ON CONFLICT DO NOTHING
        `;
      }

      for (const fragment of plugin.templateFragments) {
        if (plugin.state !== "active") {
          continue;
        }

        await sql`
          INSERT INTO core.hook_fragments (generation, name, body, plugin_id, kind)
          VALUES (${generation}, ${fragment.name}, ${fragment.body}, ${plugin.id}, ${fragment.kind})
          ON CONFLICT DO NOTHING
        `;
        await sql`
          INSERT INTO core.plugin_registry (plugin_id, kind, key, definition)
          VALUES (
            ${plugin.id}, 'fragment', ${fragment.name},
            (${JSON.stringify({ kind: fragment.kind, deps: fragment.deps ?? [] })}::text)::jsonb
          )
          ON CONFLICT DO NOTHING
        `;
      }

      if (plugin.settings !== null) {
        await sql`
          INSERT INTO core.plugin_registry (plugin_id, kind, key, definition)
          VALUES (
            ${plugin.id}, 'setting', ${plugin.id},
            (${JSON.stringify(plugin.settings)}::text)::jsonb
          )
          ON CONFLICT DO NOTHING
        `;
      }

      for (const page of plugin.adminPages ?? []) {
        await sql`
          INSERT INTO core.plugin_registry (plugin_id, kind, key, definition)
          VALUES (
            ${plugin.id}, 'page', ${page.id},
            (${JSON.stringify({ kind: page.kind, titleKey: page.titleKey, ...page.definition })}::text)::jsonb
          )
          ON CONFLICT DO NOTHING
        `;
      }

      for (const action of plugin.forumActions) {
        await sql`
          INSERT INTO core.plugin_registry (plugin_id, kind, key, definition)
          VALUES (
            ${plugin.id}, 'forum_action', ${action},
            (${JSON.stringify({ labelKey: `${SETTING_LABEL(plugin.id)}.${action}` })}::text)::jsonb
          )
          ON CONFLICT DO NOTHING
        `;
      }

      for (const flag of plugin.flags) {
        await sql`
          INSERT INTO core.plugin_registry (plugin_id, kind, key, definition)
          VALUES (
            ${plugin.id}, 'flag', ${`plugin.${plugin.id}.${flag}`},
            '{"affectsRender":true}'::jsonb
          )
          ON CONFLICT DO NOTHING
        `;
      }

      for (const event of plugin.events) {
        await sql`
          INSERT INTO core.plugin_event_subscriptions (plugin_id, event_type)
          VALUES (${plugin.id}, ${event})
          ON CONFLICT DO NOTHING
        `;
      }

      for (const job of plugin.jobs) {
        await sql`
          INSERT INTO core.plugin_jobs (plugin_id, name, schedule)
          VALUES (${plugin.id}, ${job.name}, ${job.schedule ?? null})
          ON CONFLICT DO NOTHING
        `;
        await sql`
          INSERT INTO core.plugin_registry (plugin_id, kind, key, definition)
          VALUES (
            ${plugin.id}, 'job', ${job.name},
            (${JSON.stringify(job.schedule === undefined ? {} : { schedule: job.schedule })}::text)::jsonb
          )
          ON CONFLICT DO NOTHING
        `;
      }
    }
  },
};
