import type { FlagRuntime, FlagViewer } from "@bulletin/flags";

/**
 * The `flags` object templates use as `{% if flags.newEditor %}`. It carries every flag's
 * evaluated value for this viewer; the viewer never sees a definition or a raw rule.
 */
export function createFlagTemplateContext(
  runtime: FlagRuntime,
  viewer: FlagViewer,
): Readonly<Record<string, boolean>> {
  return runtime.evaluateAll(viewer);
}
