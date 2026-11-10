import { describe, expect, test } from "bun:test";
import { createFragmentCache } from "@bulletin/cache";
import { createServerT } from "@bulletin/i18n";
import {
  loadSpikeFixtures,
  loadTheme,
  SPIKE_FOOTER_TEMPLATE,
  SPIKE_PAGE_TEMPLATE,
  type SpikeHookFixture,
} from "@bulletin/templates";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { spikeRenderingContract } from "../../apps/user-app/src/contracts.ts";
import { renderSpikePage } from "../../apps/user-app/src/spike/page.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

const SHIPPED = {
  en: {
    "spike.rendering.title": "Rendering spike",
    "spike.rendering.altTitle": "Alternate theme",
    "spike.rendering.body": "Body",
    "spike.rendering.theme": "Theme",
    "spike.rendering.plugins": "Plugin generation",
    "spike.rendering.hook": "Plugin fragment",
    "spike.rendering.counter": "Clicks",
    "spike.rendering.footer": "Footer",
    "spike.rendering.trusted": "Trusted",
  },
} as const;

/** Writes the spike fixtures the same way the base seed does. */
async function seedFixtures(database: TestDatabase): Promise<void> {
  const fixtures = await loadSpikeFixtures();

  for (const theme of fixtures.themes) {
    await database.sql`
      INSERT INTO core.themes (name, version)
      VALUES (${theme.name}, ${theme.version})
    `;
  }

  for (const theme of fixtures.themes) {
    if (theme.parent === null) {
      continue;
    }

    await database.sql`
      UPDATE core.themes
      SET parent_id = (SELECT parent.id FROM core.themes AS parent WHERE parent.name = ${theme.parent})
      WHERE name = ${theme.name}
    `;
  }

  for (const theme of fixtures.themes) {
    for (const [name, body] of Object.entries(theme.templates)) {
      await database.sql`
        INSERT INTO core.theme_templates (theme_id, name, body)
        SELECT id, ${name}, ${body} FROM core.themes WHERE name = ${theme.name}
      `;
    }
  }

  for (const hook of fixtures.hooks as readonly SpikeHookFixture[]) {
    await database.sql`
      INSERT INTO core.render_spike_hooks (generation, name, body)
      VALUES (${hook.generation}, ${hook.hook}, ${hook.body})
    `;
  }
}

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "render_spike" }, async (database) => {
    await seedFixtures(database);
    await run(database);
  });
}

function input(
  database: TestDatabase,
  overrides: Partial<Parameters<typeof renderSpikePage>[0]> = {},
): Parameters<typeof renderSpikePage>[0] {
  return {
    sql: database.sql,
    theme: "default",
    plugins: 1,
    bust: 0,
    locale: "en",
    translate: createServerT("en", { shipped: SHIPPED }),
    contract: spikeRenderingContract,
    ...overrides,
  };
}

integrationDescribe("theme templates", () => {
  test("loads the ancestor chain with leaf-first overrides", async () => {
    await withDb(async (database) => {
      const alt = await loadTheme(database.sql, "alt");

      if (alt === null) {
        throw new Error("expected the alt theme");
      }

      expect(alt.theme.name).toBe("alt");
      expect(alt.chain.map((entry) => entry.name)).toEqual(["alt", "default"]);
      expect(alt.templates.get(SPIKE_PAGE_TEMPLATE)?.map((template) => template.themeName)).toEqual(
        ["alt", "default"],
      );
      expect(
        alt.templates.get(SPIKE_FOOTER_TEMPLATE)?.map((template) => template.themeName),
      ).toEqual(["default"]);

      const byId = await loadTheme(database.sql, alt.theme.id);
      expect(byId?.theme.name).toBe("alt");

      expect(await loadTheme(database.sql, "missing")).toBeNull();
    });
  });

  test("renders the child page with the parent's footer and escaping", async () => {
    await withDb(async (database) => {
      const outcome = await renderSpikePage(input(database, { theme: "alt", plugins: 2 }));

      if (outcome.status !== "ok") {
        throw new Error("expected the spike page to render");
      }

      expect(outcome.html).toContain('data-spike-layout="alt"');
      expect(outcome.html).not.toContain('data-spike-layout="default"');
      // `alt` overrides only `page`, so the footer comes from `default`.
      expect(outcome.html).toContain('data-spike-footer-template="default"');
      expect(outcome.html).toContain('data-spike-hook="2"');
      expect(outcome.html).toContain('<bl-island data-name="SpikeCounter"');
      expect(outcome.html).toContain("<button");
      // SafeHtml renders as markup.
      expect(outcome.html).toContain("<strong data-spike-safe>Trusted</strong>");
      expect(outcome.errors).toEqual([]);

      // Plain view-model text stays escaped (the default theme prints the hostile sample).
      const themed = await renderSpikePage(input(database, { bust: 9 }));

      if (themed.status !== "ok") {
        throw new Error("expected the default theme to render");
      }

      expect(themed.html).toContain("&lt;script&gt;alert(&quot;spike&quot;)&lt;/script&gt;");
      expect(themed.html).not.toContain('<script>alert("spike")</script>');
    });
  });

  test("takes effect on the next request when a template is edited", async () => {
    await withDb(async (database) => {
      const first = await renderSpikePage(input(database, { bust: 1 }), createFragmentCache());

      if (first.status !== "ok") {
        throw new Error("expected the first render");
      }

      expect(first.html).not.toContain("data-spike-footer-edit");

      await database.sql`
        UPDATE core.theme_templates
        SET body = '<footer data-spike-footer-edit>Edited footer</footer>', version = version + 1
        WHERE name = ${SPIKE_FOOTER_TEMPLATE}
          AND theme_id = (SELECT id FROM core.themes WHERE name = 'default')
      `;

      const second = await renderSpikePage(input(database, { bust: 2 }), createFragmentCache());

      if (second.status !== "ok") {
        throw new Error("expected the second render");
      }

      expect(second.html).toContain("data-spike-footer-edit");
    });
  });

  test("caches per theme and plugin generation with no content leaking across variants", async () => {
    await withDb(async (database) => {
      const cache = createFragmentCache();
      const base = await renderSpikePage(input(database), cache);
      const warm = await renderSpikePage(input(database), cache);
      const alt = await renderSpikePage(input(database, { theme: "alt" }), cache);
      const plugin = await renderSpikePage(input(database, { plugins: 2 }), cache);
      const baseAgain = await renderSpikePage(input(database), cache);

      if (
        base.status !== "ok" ||
        warm.status !== "ok" ||
        alt.status !== "ok" ||
        plugin.status !== "ok" ||
        baseAgain.status !== "ok"
      ) {
        throw new Error("expected every spike variant to render");
      }

      expect(base.cache).toBe("MISS");
      expect(warm.cache).toBe("HIT");
      expect(warm.html).toBe(base.html);

      expect(alt.cache).toBe("MISS");
      expect(alt.variant).not.toBe(base.variant);
      expect(alt.html).toContain('data-spike-layout="alt"');
      expect(alt.html).not.toContain('data-spike-layout="default"');

      expect(plugin.cache).toBe("MISS");
      expect(plugin.variant).not.toBe(base.variant);
      expect(plugin.html).toContain('data-spike-hook="2"');
      expect(plugin.html).not.toContain('data-spike-hook="1"');
      expect(base.html).toContain('data-spike-hook="1"');

      expect(baseAgain.cache).toBe("HIT");
      expect(baseAgain.variant).toBe(base.variant);
    });
  });
});
