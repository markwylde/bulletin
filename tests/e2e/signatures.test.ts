import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForExpression,
  waitForSelector,
  waitForText,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Run against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const FORUM_URL = new URL("/forum/5-off-topic", USER_URL).toString();
const TOPIC_TITLE = "What are you reading this month?";
const SIGNATURE = "E2E *signature* text";

async function topicHref(view: Bun.WebView): Promise<string> {
  await waitForSelector(view, "[data-topic-list]", 20_000);

  const href = await view.evaluate<string | null>(`(() => {
    const link = [...document.querySelectorAll("[data-topic-list] [data-topic-link]")].find(
      (element) => element.textContent?.includes(${JSON.stringify(TOPIC_TITLE)})
    );
    return link?.getAttribute("href") ?? null;
  })()`);

  if (href === null) {
    throw new Error("The seeded signature topic is missing");
  }

  return new URL(href, USER_URL).toString();
}

async function openProfileEditor(view: Bun.WebView): Promise<void> {
  await view.navigate(new URL("/account/profile", USER_URL).toString());
  await waitForSelector(view, "[data-profile-edit-page]", 20_000);
  await waitForSelector(view, "[data-profile-signature]", 20_000);
}

async function save(view: Bun.WebView): Promise<void> {
  await waitForSelector(view, "[data-profile-save]:not([disabled])");
  await clickSelector(view, "[data-profile-save]");
  await waitForSelector(view, "[data-profile-saved]:not([hidden])", 20_000);
}

integrationDescribe("signatures", () => {
  test("renders a signature and hides it from the member's overlay at 360px", async () => {
    await withPage(
      {
        url: USER_URL,
        viewport: "mobile360",
        allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
      },
      async (view) => {
        await loginAs(view, "member-1");

        try {
          await openProfileEditor(view);
          await setInputValue(view, "[data-profile-signature]", SIGNATURE);

          const hidden = await view.evaluate<boolean>(
            'document.querySelector("[data-profile-hide-signatures]")?.checked === true',
          );

          if (hidden) {
            await clickSelector(view, "[data-profile-hide-signatures]");
          }

          await save(view);

          await view.navigate(FORUM_URL);
          const topic = await topicHref(view);
          await view.navigate(topic);
          await waitForSelector(view, "[data-topic-page]", 20_000);
          await waitForSelector(view, "[data-signature]", 20_000);
          await waitForText(view, "E2E signature text", 20_000);
          expect(
            await view.evaluate<string>(
              'getComputedStyle(document.querySelector("[data-signature]")).display',
            ),
          ).not.toBe("none");

          await openProfileEditor(view);
          await waitForSelector(view, "[data-profile-hide-signatures]:not([disabled])");
          await clickSelector(view, "[data-profile-hide-signatures]");
          await save(view);

          await view.navigate(topic);
          await waitForSelector(view, "[data-topic-page]", 20_000);
          await waitForExpression(
            view,
            'document.documentElement.dataset.overlayApplied === "true"',
            20_000,
          );
          await waitForExpression(
            view,
            `[...document.querySelectorAll("[data-signature]")].every(
              (element) => getComputedStyle(element).display === "none"
            )`,
            20_000,
          );
          expect(
            await view.evaluate<number>('document.querySelectorAll("[data-signature]").length'),
          ).toBeGreaterThan(0);
        } finally {
          // Leave the shared seeded profile with signatures visible for other tests.
          try {
            await openProfileEditor(view);
            const checked = await view.evaluate<boolean>(
              'document.querySelector("[data-profile-hide-signatures]")?.checked === true',
            );

            if (checked) {
              await clickSelector(view, "[data-profile-hide-signatures]");
              await save(view);
            }
          } catch {
            // The test already failed; the reset is best effort.
          }
        }
      },
    );
  }, 180_000);
});
