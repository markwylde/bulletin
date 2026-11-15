import { describe, expect, test } from "bun:test";
import {
  loginAs,
  waitForExpression,
  waitForSelector,
  withPage,
  withPages,
} from "@bulletin/test-utils/e2e";
import { stackOrigin, userBaseUrl } from "@bulletin/test-utils/urls";

// Plugin iframe apps and the per-frame MessageChannel bridge (ADR 0009, tasks 3.8/3.10).
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const PLUGIN_ORIGIN = stackOrigin("plugins");
const PLUGIN_APP_URL = `${PLUGIN_ORIGIN}/apps/sandbox-demo/1/client/index.html`;

async function openTopic(view: Bun.WebView): Promise<void> {
  await loginAs(view, "member-1");
  await view.navigate(new URL("/forum/5-off-topic", USER_URL).toString());
  await waitForSelector(view, "[data-topic-list]", 20_000);
  const href = await view.evaluate<string | null>(
    'document.querySelector("[data-topic-list] [data-topic-link]")?.getAttribute("href") ?? null',
  );

  if (href === null) {
    throw new Error("Missing topic link");
  }

  await view.navigate(new URL(href, USER_URL).toString());
  await waitForSelector(view, 'iframe[data-plugin-frame="sandbox-demo"]', 20_000);
}

integrationDescribe("plugin client app bridge", () => {
  test("renders a sandboxed plugin frame and completes a route call through the bridge", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await openTopic(view);

      expect(
        await view.evaluate<string>(
          'document.querySelector(\'iframe[data-plugin-frame="sandbox-demo"]\').getAttribute("sandbox")',
        ),
      ).toBe("allow-scripts allow-forms");
      expect(
        await view.evaluate<string>(
          'document.querySelector(\'iframe[data-plugin-frame="sandbox-demo"]\').getAttribute("src")',
        ),
      ).toStartWith(`${PLUGIN_ORIGIN}/apps/sandbox-demo/`);

      // The app calls its own route on load; the host records the viewer-aware response, and
      // the guest reports its measured content size over the same port.
      await waitForExpression(
        view,
        `(() => {
          const frame = document.querySelector('iframe[data-plugin-frame="sandbox-demo"]');
          return (frame?.dataset.bridgeBody ?? "").startsWith("viewer:")
            && Number(frame?.dataset.bridgeHeight ?? "0") > 0;
        })()`,
        30_000,
      );
      expect(
        await view.evaluate<string>(
          "document.querySelector('iframe[data-plugin-frame=\"sandbox-demo\"]').dataset.bridgeBody",
        ),
      ).not.toBe("viewer:guest");
    });
  }, 120_000);

  test("plugin origin has no forum cookies and its API is unauthenticated", async () => {
    await withPages(
      {
        forum: { url: USER_URL, viewport: "mobile360" },
        plugin: { url: PLUGIN_APP_URL, viewport: "mobile360" },
      },
      async ({ forum, plugin }) => {
        await loginAs(forum, "member-1");

        expect(await plugin.evaluate<string>("document.cookie")).toBe("");
        expect(await plugin.evaluate<boolean>("Boolean(document.getElementById('tip'))")).toBe(
          true,
        );
        // The plugin origin is a separate host; host-only forum cookies are never sent here.
        expect(await plugin.evaluate<string>("location.hostname")).toBe(
          "plugins.bulletin.localhost",
        );
      },
    );
  }, 120_000);

  test("window messages cannot drive another frame's bridge", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await openTopic(view);
      await waitForExpression(
        view,
        'document.querySelector(\'iframe[data-plugin-frame="sandbox-demo"]\').dataset.bridgeBody?.startsWith("viewer:") === true',
        30_000,
      );
      const before = await view.evaluate<string>(
        "document.querySelector('iframe[data-plugin-frame=\"sandbox-demo\"]').style.height",
      );

      // The host never listens to window messages; only the per-iframe port with its random
      // token is trusted. A spoofed window message must not change the frame.
      await view.evaluate(
        'window.postMessage({ type: "bulletin:bridge", token: "spoofed", id: "1", path: "tip" }, "*")',
      );
      await Bun.sleep(200);
      expect(
        await view.evaluate<string>(
          "document.querySelector('iframe[data-plugin-frame=\"sandbox-demo\"]').style.height",
        ),
      ).toBe(before);
    });
  }, 120_000);
});
