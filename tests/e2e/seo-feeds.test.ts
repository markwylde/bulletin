import { describe, expect, test } from "bun:test";
import { loginAs, withPage } from "@bulletin/test-utils/e2e";
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

// Task 1.3: sitemaps and feeds are CDN-cacheable and a guest revocation purges them.

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const STAFF_URL = staffBaseUrl();
const CDN = `${USER_URL}/_mocks/cdn`;

async function purgeForums(keys: readonly string[]): Promise<void> {
  const response = await fetch(`${CDN}/purge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys }),
  });

  expect(response.status).toBe(200);
}

function saveGuestRead(forumId: string, allowed: boolean): string {
  return `(async () => {
    const session = await (
      await fetch("/api/auth/session", { headers: { accept: "application/json" } })
    ).json();
    const matrix = await (
      await fetch("/api/staff/masks", { headers: { accept: "application/json" } })
    ).json();
    const guest = matrix.masks.find((mask) => mask.key === "guest");
    const response = await fetch("/api/staff/masks", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bulletin-csrf": session.csrfToken },
      body: JSON.stringify({
        action: "cell",
        forumId: "${forumId}",
        maskId: guest.id,
        permissionAction: "read",
        allowed: ${allowed},
        inherits: false,
      }),
    });
    return response.status;
  })()`;
}

integrationDescribe("sitemaps and feeds", () => {
  test("serves public sitemaps and feeds without a session", async () => {
    const sitemap = await fetch(`${USER_URL}/sitemap.xml`);
    const boards = await fetch(`${USER_URL}/sitemap/forums/1.xml`);
    const feed = await fetch(`${USER_URL}/feed.xml`);
    const atom = await fetch(`${USER_URL}/feed.atom`);
    const forumFeed = await fetch(`${USER_URL}/feed/forum/2-announcements.atom`);

    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get("content-type")).toContain("application/xml");
    expect(await sitemap.text()).toContain("<sitemapindex");

    expect(boards.status).toBe(200);
    expect(await boards.text()).toContain("<loc>");

    expect(feed.status).toBe(200);
    expect(feed.headers.get("content-type")).toContain("application/rss+xml");
    expect(await feed.text()).toContain("<rss");

    expect(atom.status).toBe(200);
    expect(atom.headers.get("content-type")).toContain("application/atom+xml");
    expect(await atom.text()).toContain("<feed");

    expect(forumFeed.status).toBe(200);
    expect(await forumFeed.text()).toContain("<feed");
  }, 60_000);

  test("a forum made members-only purges its feed and sitemap from the CDN", async () => {
    await purgeForums(["forum:1", "forum:2", "forum:3", "forum:4", "forum:5"]);

    const feedPath = "/feed/forum/2-announcements.xml";
    const sitemapPath = "/sitemap/forums/1.xml";
    const firstFeed = await fetch(`${CDN}${feedPath}`);
    const warmFeed = await fetch(`${CDN}${feedPath}`);
    const firstSitemap = await fetch(`${CDN}${sitemapPath}`);
    const warmSitemap = await fetch(`${CDN}${sitemapPath}`);

    expect(firstFeed.headers.get("x-cache")).toBe("MISS");
    expect(warmFeed.headers.get("x-cache")).toBe("HIT");
    expect(await warmFeed.text()).toContain("<rss");
    expect(firstSitemap.headers.get("x-cache")).toBe("MISS");
    expect(warmSitemap.headers.get("x-cache")).toBe("HIT");
    expect(await warmSitemap.text()).toContain("/forum/2-announcements");

    await withPage({ url: `${STAFF_URL}/permissions/masks`, viewport: "desktop" }, async (view) => {
      await loginAs(view, "admin");

      let revoked = false;

      try {
        expect(await view.evaluate<number>(saveGuestRead("2", false))).toBe(200);
        revoked = true;

        const deniedFeed = await fetch(`${CDN}${feedPath}`);
        const deniedSitemap = await fetch(`${CDN}${sitemapPath}`);

        expect(deniedFeed.headers.get("x-cache")).toBe("MISS");
        expect(deniedFeed.status).toBe(404);
        expect(deniedSitemap.headers.get("x-cache")).toBe("MISS");

        const sitemapBody = await deniedSitemap.text();
        expect(deniedSitemap.status).toBe(200);
        expect(sitemapBody).not.toContain("/forum/2-announcements");
      } finally {
        if (revoked) {
          expect(await view.evaluate<number>(saveGuestRead("2", true))).toBe(200);
        }
      }
    });
  }, 120_000);
});
