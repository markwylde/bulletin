import { createElement } from "react";
import { useFlag } from "../flags.tsx";

/** A plugin iframe app slot. It renders nothing unless the `plugins` flag is on. */
export interface PluginAppProps {
  readonly pluginId: string;
  readonly version: string;
  readonly app: string;
  readonly viewJson: string;
}

export function PluginApp({ pluginId, version, app, viewJson }: PluginAppProps) {
  if (!useFlag("plugins")) {
    return null;
  }

  return createElement("bl-plugin-app", {
    "data-plugin-id": pluginId,
    "data-version": version,
    "data-app": app,
    "data-view": viewJson,
  });
}
