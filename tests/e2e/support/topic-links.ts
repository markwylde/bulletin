import { waitForPageLoad, waitForSelector } from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

/**
 * Finds a topic by title across every page of a forum list.
 *
 * The E2E stack keeps its database between runs, and runs add topics, so a seeded topic can
 * move past the first page. Journeys must look it up instead of assuming page one.
 */
export async function findTopicHref(
  view: Bun.WebView,
  forumPath: string,
  title: string,
  maxPages = 20,
): Promise<string | null> {
  const userUrl = userBaseUrl();
  await waitForPageLoad(view);
  await view.navigate(new URL(forumPath, userUrl).toString());

  for (let page = 0; page < maxPages; page += 1) {
    await waitForSelector(view, "[data-topic-list]", 20_000);
    const href = await view.evaluate<string | null>(`(() => {
      const link = [...document.querySelectorAll("[data-topic-list] [data-topic-link]")].find(
        (element) => element.textContent?.includes(${JSON.stringify(title)})
      );
      return link?.getAttribute("href") ?? null;
    })()`);

    if (href !== null) {
      return href;
    }

    const next = await view.evaluate<string | null>(
      'document.querySelector("[data-page-next]")?.getAttribute("href") ?? null',
    );

    if (next === null) {
      return null;
    }

    await waitForPageLoad(view);
    await view.navigate(new URL(next, userUrl).toString());
  }

  return null;
}
