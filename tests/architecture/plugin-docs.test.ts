import { describe, expect, test } from "bun:test";
import { parsePluginManifest } from "@bulletin/plugin-sdk/manifest";

const DOCS = ["README.md", "sdk.md", "hooks.md", "capabilities.md", "sandbox-limits.md"];
const SAMPLES = ["hide-post-count", "welcome-bot", "tip-jar", "topic-notice"];

describe("plugin documentation and samples", () => {
  test("every plugin guide exists", async () => {
    for (const doc of DOCS) {
      const file = Bun.file(new URL(`../../docs/plugins/${doc}`, import.meta.url));
      expect(await file.exists()).toBe(true);
      expect((await file.text()).trim().length).toBeGreaterThan(200);
    }
  });

  test("each sample follows the documented bundle contract", async () => {
    for (const id of SAMPLES) {
      const root = new URL(`../../mocks/marketplace/plugins/${id}/`, import.meta.url);
      const manifest = parsePluginManifest(await Bun.file(new URL("plugin.json", root)).json());

      expect(manifest.id).toBe(id);
      expect(await Bun.file(new URL(manifest.entry, root)).exists()).toBe(true);

      for (const migration of manifest.migrations) {
        expect(await Bun.file(new URL(migration, root)).exists()).toBe(true);
      }

      for (const app of manifest.clientApps) {
        expect(await Bun.file(new URL(app.entry, root)).exists()).toBe(true);
      }

      for (const fragment of manifest.templateFragments) {
        expect(fragment.body.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
