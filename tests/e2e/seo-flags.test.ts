import { describe, expect, test } from "bun:test";
import { loginAs, waitForSelector, withPage } from "@bulletin/test-utils/e2e";
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

// Task 4.1: the `feeds` flag turns the XML routes off and removes the footer links.

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const STAFF_URL = staffBaseUrl();

function saveFeedsRules(rules: string): string {
  return `(async () => {
    const session = await (
      await fetch("/api/auth/session", { headers: { accept: "application/json" } })
    ).json();
    const response = await fetch("/api/staff/flags", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bulletin-csrf": session.csrfToken },
      body: JSON.stringify({ key: "feeds", rules: ${rules} }),
    });
    return response.status;
  })()`;
}

integrationDescribe("feeds flag", () => {
  test("off answers 404 on every feed route and hides the footer links", async () => {
    await withPage({ url: `${STAFF_URL}/flags`, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-page="flags"]');

      try {
        // The flag is seeded on; a guest rule makes the test independent of the seed state.
        expect(
          await view.evaluate<number>(
            saveFeedsRules('[{"type":"group","groups":["guests"],"value":true}]'),
          ),
        ).toBe(200);

        for (const path of ["/feed.xml", "/feed.atom"]) {
          const response = await fetch(`${USER_URL}${path}`);
          expect({ path, status: response.status }).toEqual({ path, status: 200 });
        }

        const onHome = await fetch(USER_URL);
        expect(await onHome.text()).toContain("data-feed-links");

        expect(
          await view.evaluate<number>(
            saveFeedsRules('[{"type":"group","groups":["guests"],"value":false}]'),
          ),
        ).toBe(200);

        for (const path of [
          "/feed.xml",
          "/feed.atom",
          "/feed/forum/2-announcements.xml",
          "/feed/forum/2-announcements.atom",
        ]) {
          const response = await fetch(`${USER_URL}${path}`);
          expect({ path, status: response.status }).toEqual({ path, status: 404 });
        }

        const home = await fetch(USER_URL);
        expect(home.status).toBe(200);
        expect(await home.text()).not.toContain("data-feed-links");
      } finally {
        expect(await view.evaluate<number>(saveFeedsRules("[]"))).toBe(200);
      }
    });
  }, 120_000);
});
