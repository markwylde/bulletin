import { describe, expect, test } from "bun:test";
import { loginAs, withPage } from "@bulletin/test-utils/e2e";
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

// Task 6.2: a forum made private for guests is purged from the CDN in the request path.

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const STAFF_URL = staffBaseUrl();
const CDN = `${USER_URL}/_mocks/cdn`;

async function purgeForumTree(): Promise<void> {
  const response = await fetch(`${CDN}/purge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      keys: ["forum:1", "forum:2", "forum:3", "forum:4", "forum:5"],
    }),
  });

  expect(response.status).toBe(200);
}

interface Matrix {
  readonly masks: ReadonlyArray<{ readonly id: string; readonly key: string }>;
}

/**
 * Saves one guest permission cell through the staff API from the authenticated staff page.
 * The request path must purge the CDN subtree before replying (best effort).
 */
function saveGuestRead(allowed: boolean): string {
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
        forumId: "1",
        maskId: guest.id,
        permissionAction: "read",
        allowed: ${allowed},
        inherits: false,
      }),
    });
    return response.status;
  })()`;
}

integrationDescribe("CDN purge on guest revocation", () => {
  test("revoking guest read purges the forum subtree from the CDN", async () => {
    await purgeForumTree();

    const first = await fetch(`${CDN}/_demo/2`);
    const warm = await fetch(`${CDN}/_demo/2`);

    expect(first.headers.get("x-cache")).toBe("MISS");
    expect(warm.headers.get("x-cache")).toBe("HIT");
    expect(await warm.text()).toContain("data-demo-topics");

    await withPage({ url: `${STAFF_URL}/permissions/masks`, viewport: "desktop" }, async (view) => {
      await loginAs(view, "admin");

      let revoked = false;

      try {
        expect(await view.evaluate<number>(saveGuestRead(false))).toBe(200);
        revoked = true;

        // The staff mutation purged forum:1 and its subtree, so the guest entry is gone and
        // the new render shows the denial instead of the cached topics.
        const denied = await fetch(`${CDN}/_demo/2`);

        expect(denied.headers.get("x-cache")).toBe("MISS");

        const html = await denied.text();
        expect(html).toContain("data-theme-error");
        expect(html).not.toContain("data-demo-topics");
      } finally {
        if (revoked) {
          expect(await view.evaluate<number>(saveGuestRead(true))).toBe(200);
        }
      }
    });
  }, 120_000);
});
