import { describe, expect, test } from "bun:test";
import {
  loginAs,
  VIEWPORTS,
  type ViewportName,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

// Run against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const STAFF_URL = staffBaseUrl();
const VIEWPORT_NAMES = Object.keys(VIEWPORTS) as ViewportName[];
const EMBED_SRC = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";

function forumUrl(ref: string): string {
  return new URL(`/forum/${ref}`, USER_URL).toString();
}

integrationDescribe("forum page", () => {
  for (const viewportName of VIEWPORT_NAMES) {
    const viewport = VIEWPORTS[viewportName];

    test(`renders the forum page at ${viewportName} (${viewport.width}x${viewport.height})`, async () => {
      await withPage({ url: forumUrl("2-announcements"), viewport: viewportName }, async (view) => {
        await waitForSelector(view, "[data-forum-page]", 20_000);

        expect(await view.evaluate<number>("document.documentElement.clientWidth")).toBe(
          viewport.width,
        );
        expect(
          await view.evaluate<boolean>("Boolean(document.querySelector('[data-breadcrumbs]'))"),
        ).toBe(true);
        expect(
          await view.evaluate<boolean>("Boolean(document.querySelector('[data-rules]'))"),
        ).toBe(true);
      });
    }, 90_000);
  }

  test("remembers the rules box collapse per viewer", async () => {
    await withPage({ url: forumUrl("2-announcements"), viewport: "mobile360" }, async (view) => {
      await waitForSelector(view, "[data-rules]", 20_000);
      expect(await view.evaluate<boolean>("document.querySelector('[data-rules]').open")).toBe(
        true,
      );

      await view.evaluate("document.querySelector('[data-rules] summary').click()");
      expect(await view.evaluate<boolean>("document.querySelector('[data-rules]').open")).toBe(
        false,
      );

      await view.navigate(forumUrl("2-announcements"));
      await waitForSelector(view, "[data-rules]", 20_000);
      expect(await view.evaluate<boolean>("document.querySelector('[data-rules]').open")).toBe(
        false,
      );
    });
  }, 90_000);

  test("a YouTube embed renders through the theme and CSP allows its exact origin", async () => {
    await withPage({ url: `${STAFF_URL}/forums`, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-page="forums"]', 20_000);
      const rules = `Watch this video:\n\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ`;
      const status = await view.evaluate<number>(`(async () => {
        const token = sessionStorage.getItem("bulletin_csrf_token");
        const response = await fetch("/api/staff/forums", {
          method: "POST",
          credentials: "include",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...(token === null ? {} : { "x-bulletin-csrf": token }),
          },
          body: JSON.stringify({
            action: "settings",
            id: "2",
            rules: ${JSON.stringify(rules)},
            prefixIds: [],
          }),
        });

        return response.status;
      })()`);

      if (status !== 200) {
        throw new Error(`Could not save the forum rules (status ${status})`);
      }

      await view.navigate(forumUrl("2-announcements"));
      await waitForSelector(view, "iframe[data-bl-embed]", 20_000);

      const player = await view.evaluate<{ count: number; src: string | null }>(
        `(() => {
          const frames = document.querySelectorAll("iframe[data-bl-embed]");
          const first = frames[0] ?? null;
          return { count: frames.length, src: first instanceof HTMLIFrameElement ? first.src : null };
        })()`,
      );

      expect(player.count).toBe(1);
      expect(player.src).toBe(EMBED_SRC);

      // The page allows exactly the provider origin, never `*`; a blocked frame would also
      // have been reported as a console error by the harness above.
      const csp = await view.evaluate<string | null>(
        `fetch(location.href, { credentials: "include" })
          .then((response) => response.headers.get("content-security-policy"))`,
      );

      expect(csp).toContain("frame-src ");
      expect(csp).toContain("https://www.youtube-nocookie.com");
      expect(csp).not.toContain("frame-src *");
    });
  }, 120_000);

  test("prompts for the password instead of showing content", async () => {
    await withPage(
      { url: forumUrl("3-general-discussion"), viewport: "mobile360" },
      async (view) => {
        await waitForSelector(view, "[data-forum-locked]", 20_000);

        expect(
          await view.evaluate<boolean>("Boolean(document.querySelector('[data-forum-content]'))"),
        ).toBe(false);
        expect(
          await view.evaluate<boolean>(
            "Boolean(document.querySelector('[data-forum-unlock] input[name=password]'))",
          ),
        ).toBe(true);
      },
    );
  }, 90_000);
});
