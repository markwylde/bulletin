import { describe, expect, test } from "bun:test";
import { loginAs, withPage } from "@bulletin/test-utils/e2e";
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

// Task 2.2: the admin-managed robots.txt and its permission gate.

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const STAFF_URL = staffBaseUrl();

function saveRobots(robotsTxt: string): string {
  return `(async () => {
    const session = await (
      await fetch("/api/auth/session", { headers: { accept: "application/json" } })
    ).json();
    const settings = await (
      await fetch("/api/staff/settings/board", { headers: { accept: "application/json" } })
    ).json();
    const response = await fetch("/api/staff/settings/board", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bulletin-csrf": session.csrfToken },
      body: JSON.stringify({ ...settings, robotsTxt: ${JSON.stringify(robotsTxt)} }),
    });
    return response.status;
  })()`;
}

integrationDescribe("robots.txt", () => {
  test("the default file links the sitemap and admins can replace it", async () => {
    const before = await fetch(`${USER_URL}/robots.txt`);
    const beforeBody = await before.text();

    expect(before.status).toBe(200);
    expect(before.headers.get("content-type")).toContain("text/plain");
    expect(beforeBody).toContain("User-agent: *");
    expect(beforeBody).toContain("Disallow: /search");
    expect(beforeBody).toContain(`Sitemap: ${new URL(USER_URL).origin}/sitemap.xml`);

    await withPage({ url: `${STAFF_URL}/settings/board`, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");

      try {
        expect(
          await view.evaluate<number>(saveRobots("User-agent: *\nDisallow: /seo-e2e-test\n")),
        ).toBe(200);

        const custom = await fetch(`${USER_URL}/robots.txt`);
        expect(await custom.text()).toContain("Disallow: /seo-e2e-test");
      } finally {
        expect(await view.evaluate<number>(saveRobots(""))).toBe(200);
      }
    });

    const restored = await fetch(`${USER_URL}/robots.txt`);
    expect(await restored.text()).toContain("Disallow: /search");
  }, 120_000);

  test("staff without acp.settings cannot save robots.txt", async () => {
    await withPage(
      {
        url: `${STAFF_URL}/`,
        viewport: "mobile360",
        allowConsoleErrors: [/403.*settings\/board/],
      },
      async (view) => {
        await loginAs(view, "super-mod");
        expect(await view.evaluate<number>(saveRobots("User-agent: *\nDisallow: /\n"))).toBe(403);
      },
    );
  }, 60_000);
});
