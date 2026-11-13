import { createElement } from "react";

/**
 * A plugin iframe app slot. The platform only contributes this island while the `plugins`
 * flag is on (the fragment/route value is built behind the flag), so it renders here; the
 * frame can only reach plugin routes that are still enabled and installed (ADR 0009).
 */
export interface PluginAppProps {
  readonly pluginId: string;
  readonly version: string;
  readonly app: string;
  readonly viewJson: string;
  /** Exact plugin frame origin supplied by the host, never by the plugin itself (ADR 0018). */
  readonly origin?: string | undefined;
}

export function PluginApp({ pluginId, version, app, viewJson, origin }: PluginAppProps) {
  return createElement("bl-plugin-app", {
    "data-plugin-id": pluginId,
    "data-version": version,
    "data-app": app,
    "data-view": viewJson,
    ...(origin === undefined ? {} : { "data-origin": origin }),
  });
}
