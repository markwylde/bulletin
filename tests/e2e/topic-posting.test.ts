import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  VIEWPORTS,
  type ViewportName,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const FORUM_URL = new URL("/forum/5-off-topic", USER_URL).toString();

async function openNewTopicForm(view: Bun.WebView): Promise<void> {
  await waitForSelector(view, "[data-new-topic-form]", 20_000);
  await clickSelector(view, "[data-new-topic] summary");
  // The island runtime hydrates lazily when an island nears the viewport; a person opening the
  // form scrolls to the editor they want to type in.
  await view.evaluate(
    `document.querySelector('[data-new-topic-form] bl-island[data-name="Editor"]')?.scrollIntoView({ block: "center" })`,
  );
  await waitForSelector(view, '[data-new-topic-form] [data-editor-ready="true"]', 20_000);
  await waitForSelector(view, '[data-editor-mode="source"]', 20_000);
  await clickSelector(view, '[data-editor-mode="source"]');
  await waitForSelector(view, "[data-new-topic-form] [data-editor-source]", 20_000);
}

integrationDescribe("topic posting", () => {
  for (const viewportName of ["mobile360", "desktop"] as ViewportName[]) {
    const viewport = VIEWPORTS[viewportName];

    test(`creates a topic at ${viewportName} (${viewport.width}x${viewport.height})`, async () => {
      const title = `Posted from ${viewportName} ${Date.now()}`;

      await withPage({ url: USER_URL, viewport: viewportName }, async (view) => {
        await loginAs(view, "member-1");
        await view.evaluate('fetch("/api/test/reset-rate-buckets", { method: "POST" })');
        await view.navigate(FORUM_URL);
        await openNewTopicForm(view);

        await setInputValue(view, "#new-topic-title", title);
        await setInputValue(
          view,
          "[data-new-topic-form] [data-editor-source]",
          "A post written from the browser.",
        );
        await waitForSelector(view, "[data-new-topic-submit]:not([disabled])", 20_000);
        await clickSelector(view, "[data-new-topic-submit]");

        await waitForSelector(view, "[data-topic-page]", 20_000);
        await waitForExpression(
          view,
          `document.querySelector('[data-topic-title]')?.textContent?.includes(${JSON.stringify(title)}) === true`,
          20_000,
        );
        expect(
          await view.evaluate<number>(
            "document.documentElement.scrollWidth - document.documentElement.clientWidth",
          ),
        ).toBeLessThanOrEqual(1);
      });
    }, 120_000);
  }

  test("multi-quotes posts across pages in selection order", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-1");
      await view.navigate(FORUM_URL);
      await waitForSelector(view, "[data-topic-list]", 20_000);

      const href = await view.evaluate<string | null>(`(() => {
        const link = [...document.querySelectorAll('[data-topic-list] [data-topic-link]')].find(
          (element) => element.textContent?.includes('Long running discussion')
        );
        return link?.getAttribute('href') ?? null;
      })()`);

      if (href === null) {
        throw new Error("Missing the long-running seeded topic");
      }

      await view.navigate(new URL(href, USER_URL).toString());
      await waitForSelector(view, "[data-post-list]", 20_000);

      const selected: string[] = [];
      const firstPage = await view.evaluate<string[]>(
        `[...document.querySelectorAll('[data-quote-post]')].slice(0, 2).map((element) => element.getAttribute('data-quote-post') ?? '')`,
      );
      const first = firstPage[0];
      const second = firstPage[1];

      if (first === undefined || second === undefined) {
        throw new Error("Page 1 has too few posts");
      }

      await clickSelector(view, `[data-quote-post="${first}"]`);
      await clickSelector(view, `[data-quote-post="${second}"]`);
      selected.push(first, second);

      const next = await view.evaluate<string | null>(
        'document.querySelector("[data-page-next]")?.getAttribute("href") ?? null',
      );

      if (next === null) {
        throw new Error("Missing next-page link");
      }

      await view.navigate(new URL(next, USER_URL).toString());
      await waitForSelector(view, "[data-post-list]", 20_000);
      const third = await view.evaluate<string | null>(
        'document.querySelector("[data-quote-post]")?.getAttribute("data-quote-post") ?? null',
      );

      if (third === null) {
        throw new Error("Page 2 has no posts");
      }

      await clickSelector(view, `[data-quote-post="${third}"]`);
      selected.push(third);

      await clickSelector(view, "[data-reply-toggle]");
      await waitForSelector(view, "[data-reply-form]:not([hidden])", 20_000);
      await waitForSelector(view, "[data-reply-form] [data-editor-ready='true']", 20_000);

      const order = selected.map((id) => `post:${id}`);
      await waitForExpression(
        view,
        `(() => {
          const input = document.querySelector('[data-reply-form] input[name="bodyMd"]');
          if (!(input instanceof HTMLInputElement)) return false;
          const positions = ${JSON.stringify(order)}.map((token) => input.value.indexOf(token));
          return positions.every((position) => position >= 0) &&
            positions.every((position, index) => index === 0 || position > positions[index - 1]);
        })()`,
        20_000,
      );
    });
  }, 120_000);
});
