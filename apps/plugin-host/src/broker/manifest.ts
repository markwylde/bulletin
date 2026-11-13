import { join } from "node:path";
import {
  loadPluginManifest as loadSdkManifest,
  type PluginManifest,
} from "@bulletin/plugin-sdk/manifest";

/** Re-export the SDK manifest contract so install and runtime cannot drift (ADR 0009). */
export { type PluginManifest, parsePluginManifest } from "@bulletin/plugin-sdk/manifest";

export interface PluginMigration {
  readonly name: string;
  readonly sql: string;
}

export async function loadPluginManifest(bundlePath: string): Promise<PluginManifest> {
  return loadSdkManifest(bundlePath);
}

/** Reads every declared migration in order. */
export async function loadPluginMigrations(
  bundlePath: string,
  manifest: PluginManifest,
): Promise<PluginMigration[]> {
  return Promise.all(
    manifest.migrations.map(async (name) => ({
      name,
      sql: await Bun.file(join(bundlePath, name)).text(),
    })),
  );
}
