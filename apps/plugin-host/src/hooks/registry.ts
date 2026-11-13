import type {
  EnricherManifest,
  FilterManifest,
  PluginManifest,
  VetoManifest,
} from "@bulletin/plugin-sdk/manifest";

/** A plugin's hook declarations, as installed from its manifest (ADR 0009). */
export interface ActivePlugin {
  readonly manifest: PluginManifest;
  readonly generation: number;
  readonly enabled: boolean;
}

export interface EnricherEntry extends EnricherManifest {
  readonly pluginId: string;
}

export interface FilterEntry extends FilterManifest {
  readonly pluginId: string;
}

export interface VetoEntry extends VetoManifest {
  readonly pluginId: string;
}

/**
 * In-memory hook registry for the running plugin-host. The lifecycle change fills it from
 * installed manifests; the demo host installs one bundle. Ordering is stable by plugin id so
 * filter priorities and tests do not depend on start order.
 */
export class PluginHookRegistry {
  readonly #plugins = new Map<string, ActivePlugin>();

  install(
    manifest: PluginManifest,
    options: { generation?: number; enabled?: boolean } = {},
  ): void {
    this.#plugins.set(manifest.id, {
      manifest,
      generation: options.generation ?? 1,
      enabled: options.enabled ?? true,
    });
  }

  remove(pluginId: string): void {
    this.#plugins.delete(pluginId);
  }

  setEnabled(pluginId: string, enabled: boolean): void {
    const plugin = this.#plugins.get(pluginId);

    if (plugin !== undefined) {
      this.#plugins.set(pluginId, { ...plugin, enabled });
    }
  }

  get(pluginId: string): ActivePlugin | undefined {
    return this.#plugins.get(pluginId);
  }

  plugins(): readonly ActivePlugin[] {
    return [...this.#plugins.values()].filter((plugin) => plugin.enabled);
  }

  generation(): number {
    return this.plugins().reduce((max, plugin) => Math.max(max, plugin.generation), 0);
  }

  enrichers(hook: string): readonly EnricherEntry[] {
    return this.plugins()
      .flatMap((plugin) =>
        plugin.manifest.enrichers
          .filter((entry) => entry.hook === hook)
          .map((entry) => ({ ...entry, pluginId: plugin.manifest.id })),
      )
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  }

  filters(hook: string): readonly FilterEntry[] {
    return this.plugins()
      .flatMap((plugin) =>
        plugin.manifest.filters
          .filter((entry) => entry.hook === hook)
          .map((entry) => ({ ...entry, pluginId: plugin.manifest.id })),
      )
      .sort(
        (left, right) =>
          (left.priority ?? 100) - (right.priority ?? 100) ||
          left.pluginId.localeCompare(right.pluginId),
      );
  }

  vetoes(hook: string): readonly VetoEntry[] {
    return this.plugins()
      .flatMap((plugin) =>
        plugin.manifest.vetoes
          .filter((entry) => entry.hook === hook)
          .map((entry) => ({ ...entry, pluginId: plugin.manifest.id })),
      )
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  }

  subscribedTo(eventType: string): readonly string[] {
    return this.plugins()
      .filter((plugin) => plugin.manifest.events.includes(eventType))
      .map((plugin) => plugin.manifest.id)
      .sort();
  }

  contentExtensions(syntax: string): readonly string[] {
    return this.plugins()
      .filter((plugin) => plugin.manifest.contentExtensions.includes(syntax))
      .map((plugin) => plugin.manifest.id)
      .sort();
  }

  routes(kind: "page" | "api"): readonly { readonly pluginId: string; readonly path: string }[] {
    return this.plugins()
      .flatMap((plugin) =>
        plugin.manifest.routes
          .filter((route) => route.kind === kind)
          .map((route) => ({ pluginId: plugin.manifest.id, path: route.path })),
      )
      .sort((left, right) =>
        `${left.pluginId}/${left.path}`.localeCompare(`${right.pluginId}/${right.path}`),
      );
  }
}

/** The cache namespace a plugin fragment/enricher tag lives in (ADR 0009). */
export function pluginTag(pluginId: string, tag: string): string {
  return `plugin:${pluginId}:${tag.replace(/^plugin:[^:]+:/, "")}`;
}

/** Normalised hook name; a v1 plugin's legacy name maps to its v2 name. */
export function canonicalHook(hook: string): string {
  return hook;
}
