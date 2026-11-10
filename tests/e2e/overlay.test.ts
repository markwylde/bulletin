import { describe, expect, test } from "bun:test";
import { loginAs, waitForSelector, withPage } from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Tasks 6.3/6.4: the personal overlay and the guest beacon in the browser.

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const DEMO_URL = new URL("/_demo/2", USER_URL).toString();

interface OverlayResult {
  readonly status: number;
  readonly body: { readonly csrfToken?: string; readonly unread?: readonly string[] };
  readonly etag: string | null;
}

function overlayRequest(etag?: string | null): string {
  return `(async () => {
    const headers = { "content-type": "application/json", "x-bulletin-overlay": "1" };
    if (${JSON.stringify(etag ?? null)} !== null) headers["if-none-match"] = ${JSON.stringify(etag ?? null)};
    const response = await fetch("/api/me/overlay", {
      method: "POST",
      headers,
      body: JSON.stringify({ ctx: "forum:2", topics: ["201", "202", "203"] }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})), etag: response.headers.get("etag") };
  })()`;
}

integrationDescribe("personal overlay", () => {
  test("adds unread markers for members and keeps personal data out of the HTML", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-1");
      await view.navigate(DEMO_URL);
      await waitForSelector(view, '[data-overlay-unread][data-unread="true"]', 20_000);

      const html = await view.evaluate<string>(
        'fetch("/_demo/2", { credentials: "include" }).then((response) => response.text())',
      );

      expect(html).not.toContain("Regular Member One");
      expect(html).not.toContain("csrf");
      // The dev CSS mentions the attribute; the markup must not carry it before the overlay.
      expect(html).not.toMatch(/data-overlay-context="topic:[^"]+" data-unread="true"/);
      expect(html).toContain('data-overlay-context="topic:201"');

      const overlay = await view.evaluate<OverlayResult>(overlayRequest());

      expect(overlay.status).toBe(200);
      expect(overlay.body.csrfToken).toBeString();
      expect(overlay.body.unread).toEqual(["201", "202", "203"]);
      expect(overlay.etag).toMatch(/^"[0-9a-f]{64}"$/);

      const conditional = await view.evaluate<OverlayResult>(overlayRequest(overlay.etag));

      expect(conditional.status).toBe(304);
    });
  }, 120_000);

  test("guests send the beacon and never see member unread markers", async () => {
    await withPage({ url: DEMO_URL, viewport: "mobile360" }, async (view) => {
      await waitForSelector(view, '[data-visitor="guest"]');
      await Bun.sleep(500);

      expect(
        await view.evaluate<boolean>("document.querySelector('[data-unread=\"true\"]') === null"),
      ).toBe(true);
      expect(
        await view.evaluate<string>(
          'document.querySelector("[data-demo-page]")?.getAttribute("data-overlay-ctx")',
        ),
      ).toBe("forum:2");
    });
  });
});
