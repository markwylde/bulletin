import { describe, expect, test } from "bun:test";
import {
  loginAs,
  VIEWPORTS,
  type ViewportName,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Task 1.1: the complete default theme at every viewport in both schemes. The browser
// computes the WCAG ratio from the painted colours, so a token regression fails here even
// when the CSS still parses. Requires the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();

const SCHEMES = ["light", "dark"] as const;
type Scheme = (typeof SCHEMES)[number];

interface PaintedColours {
  readonly dark: boolean;
  readonly overflow: number;
  readonly bodyBackground: string;
  readonly bodyRatio: number;
  readonly brandRatio: number;
  readonly footerRatio: number;
}

async function emulateScheme(view: Bun.WebView, scheme: Scheme): Promise<void> {
  await view.cdp("Emulation.setEmulatedMedia", {
    media: "",
    features: [{ name: "prefers-color-scheme", value: scheme }],
  });
  await Bun.sleep(50);
}

function paintedColours(view: Bun.WebView): Promise<PaintedColours> {
  return view.evaluate<PaintedColours>(`(() => {
    const parse = (value) => {
      const match = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(value);
      return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
    };
    const luminance = (rgb) => {
      const channels = rgb.map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const ratio = (foreground, background) => {
      const fg = parse(foreground);
      const bg = parse(background);
      if (fg === null || bg === null) return 0;
      const light = Math.max(luminance(fg), luminance(bg));
      const dark = Math.min(luminance(fg), luminance(bg));
      return (light + 0.05) / (dark + 0.05);
    };
    const background = (element) =>
      element === null ? "" : getComputedStyle(element).backgroundColor;
    const colour = (element) => (element === null ? "" : getComputedStyle(element).color);
    const body = document.body;
    const brand = document.querySelector("[data-theme-header] .bl-header__brand");
    const footerText = document.querySelector("[data-theme-footer] .bl-footer__text");
    const header = document.querySelector("[data-theme-header]");
    const footer = document.querySelector("[data-theme-footer]");
    const bodyBackground = background(body);
    return {
      dark: matchMedia("(prefers-color-scheme: dark)").matches,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyBackground,
      bodyRatio: ratio(colour(body), bodyBackground),
      brandRatio: ratio(colour(brand), background(header)),
      footerRatio: ratio(colour(footerText), background(footer)),
    };
  })()`);
}

async function expectThemedPage(
  view: Bun.WebView,
  url: string,
  marker: string,
  scheme: Scheme,
): Promise<void> {
  await view.navigate(url);
  await waitForSelector(view, marker, 20_000);
  await waitForSelector(view, "[data-theme-header]", 20_000);
  await waitForSelector(view, "[data-theme-footer]", 20_000);

  const painted = await paintedColours(view);

  expect(painted.dark).toBe(scheme === "dark");
  expect(painted.overflow).toBeLessThanOrEqual(1);
  expect(painted.bodyBackground).toBe(scheme === "dark" ? "rgb(20, 26, 34)" : "rgb(244, 246, 249)");
  expect(painted.bodyRatio).toBeGreaterThanOrEqual(4.5);
  expect(painted.brandRatio).toBeGreaterThanOrEqual(4.5);
  expect(painted.footerRatio).toBeGreaterThanOrEqual(4.5);
}

integrationDescribe("default theme visual check", () => {
  for (const viewportName of Object.keys(VIEWPORTS) as ViewportName[]) {
    for (const scheme of SCHEMES) {
      test(`renders the home page at ${VIEWPORTS[viewportName].width}px in ${scheme}`, async () => {
        await withPage({ url: USER_URL, viewport: viewportName }, async (view) => {
          await emulateScheme(view, scheme);
          await expectThemedPage(view, USER_URL, "[data-board-index]", scheme);

          expect(await view.evaluate<number>("document.documentElement.clientWidth")).toBe(
            VIEWPORTS[viewportName].width,
          );
        });
      }, 90_000);
    }
  }

  for (const scheme of SCHEMES) {
    test(`every public page is themed and readable in ${scheme} at 360px`, async () => {
      await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
        await emulateScheme(view, scheme);
        await view.navigate(new URL("/forum/5-off-topic", USER_URL).toString());
        await waitForSelector(view, "[data-topic-list]", 20_000);

        const topicHref = await view.evaluate<string | null>(
          'document.querySelector("[data-topic-link]")?.getAttribute("href") ?? null',
        );
        await view.navigate(new URL("/members", USER_URL).toString());
        await waitForSelector(view, "[data-member-card] a", 20_000);
        const profileHref = await view.evaluate<string | null>(
          'document.querySelector("[data-member-card] a")?.getAttribute("href") ?? null',
        );

        if (topicHref === null || profileHref === null) {
          throw new Error("The seeded pages need a topic and a member profile");
        }

        const pages: readonly { readonly path: string; readonly marker: string }[] = [
          { path: "/", marker: "[data-board-index]" },
          { path: "/auth/login", marker: "[data-login-page]" },
          { path: "/forum/5-off-topic", marker: "[data-forum-page]" },
          { path: topicHref, marker: "[data-topic-page]" },
          { path: "/members", marker: "[data-member-list]" },
          { path: profileHref, marker: "[data-profile-page]" },
          { path: "/members/online", marker: "[data-online-page]" },
          { path: "/leaderboards", marker: "[data-leaderboards-page]" },
          { path: "/search", marker: "[data-search-page]" },
          { path: "/unsubscribe", marker: "[data-unsubscribe-page]" },
        ];

        for (const entry of pages) {
          await expectThemedPage(
            view,
            new URL(entry.path, USER_URL).toString(),
            entry.marker,
            scheme,
          );
        }
      });
    }, 180_000);

    test(`every member page is themed and readable in ${scheme} at 360px`, async () => {
      await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
        await emulateScheme(view, scheme);
        await view.navigate(USER_URL);
        await loginAs(view, "member-1");

        const pages: readonly { readonly path: string; readonly marker: string }[] = [
          { path: "/account", marker: "[data-account-page]" },
          { path: "/account/profile", marker: "[data-profile-edit-page]" },
          { path: "/account/notifications", marker: "[data-notifications-page]" },
          {
            path: "/account/notifications/preferences",
            marker: "[data-notification-preferences-page]",
          },
          { path: "/account/follows", marker: "[data-follows-page]" },
          { path: "/account/attachments", marker: "[data-attachments-page]" },
          { path: "/account/warnings", marker: "[data-warnings-page]" },
          { path: "/conversations", marker: "[data-conversations-page]" },
        ];

        for (const entry of pages) {
          await expectThemedPage(
            view,
            new URL(entry.path, USER_URL).toString(),
            entry.marker,
            scheme,
          );
        }
      });
    }, 180_000);
  }
});
