import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();

async function api<T>(view: Bun.WebView, path: string, body: unknown): Promise<T> {
  return view.evaluate<T>(`(async () => {
    const session = await fetch("/api/auth/session", { headers: { accept: "application/json" } })
      .then((response) => response.json());
    const response = await fetch(${JSON.stringify(path)}, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "x-bulletin-csrf": session.csrfToken ?? "",
      },
      body: JSON.stringify(${JSON.stringify(body)}),
    });
    return response.json();
  })()`);
}

integrationDescribe("post history", () => {
  test("compares two nonadjacent versions and lists every version", async () => {
    let topicUrl = "";
    let postId = "";

    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-1");
      const created = await api<{ topicId: string; postId: string; url: string }>(
        view,
        "/api/forums/5/topics",
        { title: `History ${Date.now()}`, bodyMd: "Version one" },
      );
      topicUrl = created.url;
      postId = created.postId;

      await api(view, `/api/posts/${postId}/edit`, { bodyMd: "Version two" });
      await api(view, `/api/posts/${postId}/edit`, { bodyMd: "Version three" });
    });

    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "super-mod");
      await view.navigate(new URL(topicUrl, USER_URL).toString());
      await waitForSelector(view, `[data-post-history="${postId}"]`, 20_000);
      await clickSelector(view, `[data-post-history="${postId}"]`);
      await waitForSelector(view, `[data-post-history-panel="${postId}"]:not([hidden])`, 20_000);

      await setInputValue(view, `[data-post-history-panel="${postId}"] [data-history-from]`, "0");
      await setInputValue(view, `[data-post-history-panel="${postId}"] [data-history-to]`, "2");
      await waitForExpression(
        view,
        `(() => {
          const panel = document.querySelector('[data-post-history-panel="${postId}"]');
          const diff = panel?.querySelector('[data-history-diff]')?.textContent ?? "";
          return diff.includes("Version one") && diff.includes("Version three");
        })()`,
        20_000,
      );

      expect(
        await view.evaluate<number>(
          `document.querySelectorAll('[data-post-history-panel="${postId}"] [data-history-version]').length`,
        ),
      ).toBe(3);
    });
  }, 120_000);
});
