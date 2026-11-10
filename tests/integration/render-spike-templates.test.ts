import { describe, expect, test } from "bun:test";
import { createFragmentCache } from "@bulletin/cache";
import { createServerT } from "@bulletin/i18n";
import {
  loadHookFragments,
  loadSpikeFixtures,
  loadStoredTheme,
  SPIKE_HOOK_NAME,
  SPIKE_TEMPLATE_NAME,
  type SpikeHookFixture,
  type SpikeThemeFixture,
} from "@bulletin/templates";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { renderSpikePage, SPIKE_DEFAULT_OPTIONS } from "../../apps/user-app/src/spike/page.ts";

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
  },
} as const;

async function seedFixtures(database: TestDatabase): Promise<void> {
  const fixtures = await loadSpikeFixtures();

  for (const theme of fixtures.themes as readonly SpikeThemeFixture[]) {
    await database.sql`
      INSERT INTO core.render_spike_themes (name, version)
      VALUES (${theme.theme}, ${theme.version})
    `;
    await database.sql`
      INSERT INTO core.render_spike_templates (theme_name, name, body)
      VALUES (${theme.theme}, ${SPIKE_TEMPLATE_NAME}, ${theme.template})
    `;
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
) {
  return {
    sql: database.sql,
    theme: SPIKE_DEFAULT_OPTIONS.theme,
    plugins: 1,
    bust: 0,
    locale: "en" as const,
    translate: createServerT("en", { shipped: SHIPPED }),
    ...overrides,
  };
}

integrationDescribe("spike S1 templates", () => {
  test("loads a theme and its hook fragments from Postgres", async () => {
    await withDb(async (database) => {
      const theme = await loadStoredTheme(database.sql, "alt");
      const hooks = await loadHookFragments(database.sql, 2);

      expect(theme?.version).toBe(1);
      expect(theme?.templates.get(SPIKE_TEMPLATE_NAME)).toContain('data-spike-layout="alt"');
      expect(hooks[SPIKE_HOOK_NAME]).toContain('data-spike-plugin="installed"');
      expect(await loadStoredTheme(database.sql, "missing")).toBeNull();
    });
  });

  test("renders the stored template with an SSR island and escapes view-model text", async () => {
    await withDb(async (database) => {
      const outcome = await renderSpikePage(input(database), createFragmentCache());

      if (outcome.status !== "ok") {
        throw new Error("expected the spike page to render");
      }

      expect(outcome.html).toContain('<bl-island data-name="SpikeCounter"');
      expect(outcome.html).toContain("<button");
      expect(outcome.html).toContain("&lt;script&gt;alert(&#34;spike&#34;)&lt;/script&gt;");
      expect(outcome.errors).toEqual([]);
    });
  });

  test("caches per theme and plugin generation, with no content leaking across entries", async () => {
    await withDb(async (database) => {
      const cache = createFragmentCache();
      const first = await renderSpikePage(input(database), cache);
      const second = await renderSpikePage(input(database), cache);
      const alt = await renderSpikePage(input(database, { theme: "alt" }), cache);
      const plugin = await renderSpikePage(input(database, { plugins: 2 }), cache);
      const firstAgain = await renderSpikePage(input(database), cache);

      if ([first, second, alt, plugin, firstAgain].some((result) => result.status !== "ok")) {
        throw new Error("expected every spike variant to render");
      }

      if (
        first.status !== "ok" ||
        second.status !== "ok" ||
        alt.status !== "ok" ||
        plugin.status !== "ok" ||
        firstAgain.status !== "ok"
      ) {
        return;
      }

      expect(first.cache).toBe("MISS");
      expect(second.cache).toBe("HIT");
      expect(second.html).toBe(first.html);

      expect(alt.cache).toBe("MISS");
      expect(alt.variant).not.toBe(first.variant);
      expect(alt.html).toContain('data-spike-layout="alt"');
      expect(alt.html).not.toContain('data-spike-layout="default"');
      expect(first.html).not.toContain('data-spike-layout="alt"');

      expect(plugin.cache).toBe("MISS");
      expect(plugin.variant).not.toBe(first.variant);
      expect(plugin.html).toContain('data-spike-hook="2"');
      expect(plugin.html).not.toContain('data-spike-hook="1"');
      expect(first.html).toContain('data-spike-hook="1"');

      expect(firstAgain.cache).toBe("HIT");
      expect(firstAgain.variant).toBe(first.variant);
    });
  });
});
