import { describe, expect, test } from "bun:test";
import { clickSelector, waitForSelector, withPage } from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Spike S1 proof (ADR 0008): a DB-stored Liquid template places an island that SSRs and
// hydrates, and a plugin-style hook fragment plus a theme switch produce distinct cache
// entries. Runs against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const SPIKE_URL = new URL("/spike/rendering", userBaseUrl()).toString();

/** A unique value per run forces a cold entry without sharing another test's variant. */
function bust(): number {
  return Math.floor(Date.now() % 1_000_000);
}

function spikeUrl(params: Record<string, string | number>): string {
  const url = new URL(SPIKE_URL);

  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, String(value));
  }

  return url.toString();
}

async function fetchSpike(params: Record<string, string | number>): Promise<{
  readonly html: string;
  readonly cache: string | null;
}> {
  const response = await fetch(spikeUrl(params));

  expect(response.status).toBe(200);
  return { html: await response.text(), cache: response.headers.get("x-spike-cache") };
}

integrationDescribe("spike S1 rendering", () => {
  test("serves the island's server HTML before scripts run", async () => {
    const run = bust();
    const { html, cache } = await fetchSpike({ theme: "alt", plugins: 2, bust: run });

    expect(cache).toBe("MISS");
    expect(html).toContain('<bl-island data-name="SpikeCounter"');
    expect(html).toContain('data-spike-layout="alt"');
    expect(html).toContain('data-spike-hook="2"');
    expect(html).toContain('data-spike-plugin="installed"');

    // The template's hostile sample is text, escaped, not markup.
    const themed = await fetchSpike({ theme: "default", plugins: 1, bust: run });

    expect(themed.html).toContain("&lt;script&gt;alert(&#34;spike&#34;)&lt;/script&gt;");
    expect(themed.html).not.toContain('<script>alert("spike")</script>');
  });

  test("hydrates the server-rendered island at 360 px", async () => {
    const url = spikeUrl({ theme: "default", plugins: 1, bust: bust() });

    await withPage({ url, viewport: "mobile360" }, async (view) => {
      await waitForSelector(view, "[data-spike-increment]");
      expect(
        await view.evaluate<string>("document.querySelector('[data-spike-count]').textContent"),
      ).toBe("0");

      await clickSelector(view, "[data-spike-increment]");

      expect(
        await view.evaluate<string>("document.querySelector('[data-spike-count]').textContent"),
      ).toBe("1");
      expect(await view.evaluate<boolean>("document.documentElement.clientWidth === 360")).toBe(
        true,
      );
    });
  });

  test("keeps a distinct cache entry per theme and plugin generation", async () => {
    const run = bust();
    const cold = await fetchSpike({ theme: "default", plugins: 1, bust: run });
    const warm = await fetchSpike({ theme: "default", plugins: 1, bust: run });
    const altTheme = await fetchSpike({ theme: "alt", plugins: 1, bust: run });
    const installedPlugin = await fetchSpike({ theme: "default", plugins: 2, bust: run });
    const afterOthers = await fetchSpike({ theme: "default", plugins: 1, bust: run });

    expect(cold.cache).toBe("MISS");
    expect(warm.cache).toBe("HIT");
    expect(warm.html).toBe(cold.html);

    expect(altTheme.cache).toBe("MISS");
    expect(altTheme.html).toContain('data-spike-layout="alt"');
    expect(altTheme.html).not.toContain('data-spike-layout="default"');
    expect(cold.html).not.toContain('data-spike-layout="alt"');

    expect(installedPlugin.cache).toBe("MISS");
    expect(installedPlugin.html).toContain('data-spike-hook="2"');
    expect(installedPlugin.html).not.toContain('data-spike-hook="1"');
    expect(cold.html).toContain('data-spike-hook="1"');

    expect(afterOthers.cache).toBe("HIT");
  });

  test("hydrates the alternate theme with the installed-plugin fragment", async () => {
    const url = spikeUrl({ theme: "alt", plugins: 2, bust: bust() });

    await withPage({ url, viewport: "mobile390" }, async (view) => {
      await waitForSelector(view, '[data-spike-hook="2"]');
      await clickSelector(view, "[data-spike-increment]");

      expect(
        await view.evaluate<string>("document.querySelector('[data-spike-count]').textContent"),
      ).toBe("1");
    });
  });
});
