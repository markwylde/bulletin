import { describe, expect, test } from "bun:test";
import { createLogger } from "@bulletin/config";
import type { PluginManifest } from "@bulletin/plugin-sdk/manifest";
import { withTestDatabase } from "@bulletin/test-utils/database";
import type { SQL } from "bun";
import { parsePluginManifest } from "../broker/manifest.ts";
import { publishPluginFragments } from "./publish.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const logger = createLogger({ service: "publish-test", level: "error", sink: () => {} });

interface FragmentRow {
  readonly generation: number;
  readonly name: string;
  readonly body: string;
  readonly plugin_id: string | null;
  readonly kind: string;
}

function manifest(
  id: string,
  fragments: ReadonlyArray<{ name: string; body: string; kind?: "hook" | "override" }>,
): PluginManifest {
  return parsePluginManifest({
    id,
    name: id,
    version: "1.0.0",
    sdkVersion: "^2.0.0",
    entry: "server.ts",
    templateFragments: fragments.map((fragment) => ({
      name: fragment.name,
      kind: fragment.kind ?? "hook",
      body: fragment.body,
    })),
  });
}

async function generation(sql: SQL): Promise<number> {
  const rows = (await sql`
    SELECT generation FROM core.plugin_generation WHERE id = true
  `) as Array<{ generation: number }>;
  return rows[0]?.generation ?? 0;
}

async function fragments(sql: SQL): Promise<FragmentRow[]> {
  return (await sql`
    SELECT generation, name, body, plugin_id, kind
    FROM core.hook_fragments
    ORDER BY generation, name
  `) as FragmentRow[];
}

integrationDescribe("plugin fragment publishing", () => {
  test("replaces a plugin's fragment set atomically and keeps other plugins' fragments", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "plugin_publish" }, async (database) => {
      const alpha = manifest("publish-alpha", [
        { name: "publish.alpha.topics", body: "alpha topics v1" },
        { name: "publish.alpha.footer", body: "alpha footer v1" },
      ]);
      const beta = manifest("publish-beta", [
        { name: "publish.beta.header", body: "beta header v1", kind: "override" },
      ]);

      const first = await publishPluginFragments(database.sql, alpha, logger);
      const second = await publishPluginFragments(database.sql, beta, logger);

      expect(first).toMatchObject({ changed: true });
      expect(second).toMatchObject({ changed: true });
      expect(await generation(database.sql)).toBe(1);
      expect(await fragments(database.sql)).toHaveLength(3);

      // Unchanged content does not bump the generation.
      const unchanged = await publishPluginFragments(database.sql, beta, logger);
      expect(unchanged).toEqual({ generation: 1, changed: false });

      // Partial removal: one fragment goes away, the other is updated, beta is untouched.
      const partial = manifest("publish-alpha", [
        { name: "publish.alpha.footer", body: "alpha footer v2", kind: "override" },
      ]);
      const third = await publishPluginFragments(database.sql, partial, logger);

      expect(third).toEqual({ generation: 2, changed: true });
      expect(await generation(database.sql)).toBe(2);

      const afterPartial = await fragments(database.sql);
      expect(afterPartial).toEqual([
        {
          generation: 2,
          name: "publish.alpha.footer",
          body: "alpha footer v2",
          plugin_id: "publish-alpha",
          kind: "override",
        },
        {
          generation: 2,
          name: "publish.beta.header",
          body: "beta header v1",
          plugin_id: "publish-beta",
          kind: "override",
        },
      ]);

      // Complete removal: the plugin's obsolete fragment must not survive either.
      const none = manifest("publish-alpha", []);
      const fourth = await publishPluginFragments(database.sql, none, logger);

      expect(fourth).toEqual({ generation: 3, changed: true });
      expect(await generation(database.sql)).toBe(3);
      expect(await fragments(database.sql)).toEqual([
        {
          generation: 3,
          name: "publish.beta.header",
          body: "beta header v1",
          plugin_id: "publish-beta",
          kind: "override",
        },
      ]);

      // Removing every fragment from a plugin that never had any is not a change.
      const alreadyEmpty = await publishPluginFragments(
        database.sql,
        manifest("publish-gamma", []),
        logger,
      );
      expect(alreadyEmpty).toEqual({ generation: 3, changed: false });
    });
  }, 30_000);
});
