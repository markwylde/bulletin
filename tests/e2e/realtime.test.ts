import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForExpression,
  waitForSelector,
  withPage,
  withPages,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const STAFF_URL = staffBaseUrl();
const FORUM_URL = new URL("/forum/5-off-topic", USER_URL).toString();
const EDITOR_URL = new URL("/_demo/editor", USER_URL).toString();

interface TopicTarget {
  readonly id: string;
  readonly url: string;
}

/** member-1 follows a topic and lands on its last page, ready for a stream subscription. */
async function prepareFollowerTopic(): Promise<TopicTarget> {
  let target: TopicTarget | null = null;

  await withPage({ url: USER_URL, viewport: "desktop" }, async (view) => {
    await loginAs(view, "member-1");
    await view.navigate(FORUM_URL);
    await waitForSelector(view, "[data-topic-list] [data-topic-link]");

    const href = await view.evaluate<string | null>(
      'document.querySelector("[data-topic-list] [data-topic-link]")?.getAttribute("href") ?? null',
    );

    if (href === null) {
      throw new Error("Missing topic link");
    }

    await view.navigate(new URL(href, USER_URL).toString());
    await waitForSelector(view, "[data-topic-page]");

    const id = await view.evaluate<string>(
      'document.querySelector("[data-topic-page]")?.getAttribute("data-topic-id") ?? ""',
    );
    expect(id).toMatch(/^\d+$/);

    await waitForExpression(
      view,
      `document.querySelector('[data-follow-context="topic:${id}"]')?.getAttribute("data-following") !== null`,
      20_000,
    );

    if (
      (await view.evaluate<string | null>(
        `document.querySelector('[data-follow-context="topic:${id}"]')?.getAttribute("data-following")`,
      )) !== "true"
    ) {
      const follow = `[data-follow-context="topic:${id}"] [data-follow-action="follow"]:not([disabled])`;
      await waitForSelector(view, follow);
      await clickSelector(view, follow);
      await waitForExpression(
        view,
        `document.querySelector('[data-follow-context="topic:${id}"]')?.getAttribute("data-following") === "true"`,
        20_000,
      );
    }

    // New-reply banners are for the last page only.
    for (let page = 0; page < 5; page += 1) {
      if (!(await view.evaluate<boolean>('Boolean(document.querySelector("[data-page-next]"))'))) {
        break;
      }

      await clickSelector(view, "[data-page-next]");
      await waitForSelector(view, "[data-topic-page]");
      await Bun.sleep(100);
    }

    const currentUrl = await view.evaluate<string>("window.location.href");
    target = { id, url: currentUrl };
  });

  if (target === null) {
    throw new Error("Could not prepare a topic");
  }

  return target;
}

/** Posts one reply from the given browser page and retries once when flood-limited. */
async function replyFromPage(view: Bun.WebView, topicId: string, body: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await view.evaluate<{
      status: number;
      retryAfterSeconds: number;
    }>(`(async () => {
      let token = null;
      try { token = sessionStorage.getItem("bulletin_csrf_token"); } catch {}
      if (token === null) {
        const session = await fetch("/api/auth/session", { headers: { accept: "application/json" } });
        token = (await session.json()).csrfToken ?? null;
      }
      const response = await fetch("/api/topics/${topicId}/replies", {
        method: "POST",
        headers: { "content-type": "application/json", "x-bulletin-csrf": token ?? "" },
        body: JSON.stringify({ bodyMd: ${JSON.stringify(body)} })
      });
      const payload = await response.json().catch(() => ({}));
      return { status: response.status, retryAfterSeconds: payload.retryAfterSeconds ?? 0 };
    })()`);

    if (result.status === 200) {
      return;
    }

    if (result.status === 429) {
      await Bun.sleep((result.retryAfterSeconds + 1) * 1_000);
      continue;
    }

    throw new Error(`Reply failed with ${result.status}`);
  }

  throw new Error("Reply stayed flood-limited");
}

integrationDescribe("realtime stream in the browser", () => {
  test("shows the new-replies banner and updates the bell count at 360", async () => {
    const topic = await prepareFollowerTopic();
    const replyText = `Realtime reply ${Date.now()}`;
    const secondText = `${replyText} two`;

    await withPages(
      {
        user: {
          url: USER_URL,
          viewport: "mobile360",
          // Closing an SSE connection on navigation logs a network cancellation in Chrome.
          allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
        },
        replier: {
          url: USER_URL,
          viewport: "desktop",
          allowConsoleErrors: [
            /429.*\/api\/topics\/\d+\/replies/,
            /ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/,
          ],
        },
        replier2: {
          url: USER_URL,
          viewport: "desktop",
          allowConsoleErrors: [
            /429.*\/api\/topics\/\d+\/replies/,
            /ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/,
          ],
        },
      },
      async ({ user, replier, replier2 }) => {
        if (user === undefined || replier === undefined || replier2 === undefined) {
          throw new Error("Missing pages");
        }

        await loginAs(user, "member-1");
        await user.navigate(topic.url);
        await waitForSelector(user, "[data-topic-page]");
        await waitForExpression(user, 'document.documentElement.dataset.stream === "open"', 20_000);

        await loginAs(replier, "member-2");
        await waitForSelector(replier, '[data-auth-state="authenticated"]');
        await replyFromPage(replier, topic.id, replyText);
        await loginAs(replier2, "member-fr");
        await waitForSelector(replier2, '[data-auth-state="authenticated"]');
        await replyFromPage(replier2, topic.id, secondText);

        await waitForExpression(
          user,
          'document.querySelector("[data-new-replies]")?.textContent?.includes("2 new replies") === true',
          10_000,
        );
        const banner = await user.evaluate<string>(
          'document.querySelector("[data-new-replies]")?.textContent ?? ""',
        );
        expect(banner).toContain("2 new replies");

        await waitForSelector(user, '[data-overlay-count="notifications"]:not([hidden])', 15_000);
        const count = Number(
          await user.evaluate<string>(
            'document.querySelector(\'[data-overlay-count="notifications"]\')?.textContent ?? "0"',
          ),
        );
        expect(count).toBeGreaterThan(0);

        await clickSelector(user, "[data-new-replies]");
        await waitForExpression(
          user,
          `document.body.innerText.includes(${JSON.stringify(replyText)}) && document.body.innerText.includes(${JSON.stringify(secondText)})`,
          20_000,
        );
      },
    );
  }, 300_000);

  test("keeps unsaved editor text across the re-auth round trip", async () => {
    const text = `Draft kept for reauth ${Date.now()}`;

    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-1");
      await view.navigate(EDITOR_URL);
      await waitForSelector(view, "[data-editor]", 20_000);
      await waitForSelector(view, "[data-editor-wysiwyg] .ProseMirror", 30_000);

      await view.evaluate(`(async () => {
        const session = await fetch("/api/auth/session").then((response) => response.json());
        await fetch("/api/me/drafts?contextKey=demo%3Aeditor", {
          method: "DELETE",
          headers: { "x-bulletin-csrf": session.csrfToken ?? "" }
        });
        return true;
      })()`);
      const memberId = await view.evaluate<string>(
        'fetch("/api/auth/session", { headers: { accept: "application/json" } }).then((response) => response.json()).then((session) => session.memberId)',
      );
      const draftKey = `bulletin:draft:reauth:${memberId}:demo:editor`;
      await clickSelector(view, '[data-editor-mode="source"]');
      await waitForSelector(view, "[data-editor-source]");
      await setInputValue(view, "[data-editor-source]", text);

      // The stream fires this when the background grace ends and draft autosave starts failing.
      await view.evaluate('window.dispatchEvent(new CustomEvent("bulletin:reauth"))');
      await waitForExpression(view, `localStorage.getItem(${JSON.stringify(draftKey)}) !== null`);

      await view.navigate(EDITOR_URL);
      await waitForSelector(view, "[data-draft-offer]", 20_000);
      await clickSelector(view, "[data-draft-restore]");
      await clickSelector(view, '[data-editor-mode="source"]');
      await waitForSelector(view, "[data-editor-source]");
      await waitForExpression(
        view,
        `document.querySelector("[data-editor-source]")?.value === ${JSON.stringify(text)}`,
      );
      expect(
        await view.evaluate<boolean>(`localStorage.getItem(${JSON.stringify(draftKey)}) === null`),
      ).toBe(true);
    });
  }, 180_000);

  test("a revoked session's open page switches to logged out", async () => {
    await withPages(
      {
        user: {
          url: USER_URL,
          viewport: "mobile360",
          allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
        },
        staff: {
          url: STAFF_URL,
          viewport: "desktop",
          allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
        },
      },
      async ({ user, staff }) => {
        if (user === undefined || staff === undefined) {
          throw new Error("Missing pages");
        }

        await loginAs(user, "member-1");
        await waitForExpression(user, 'document.documentElement.dataset.stream === "open"', 20_000);
        const memberId = await user.evaluate<string>(
          'fetch("/api/auth/session", { headers: { accept: "application/json" } }).then((response) => response.json()).then((body) => body.memberId)',
        );
        expect(memberId).toMatch(/^\d+$/);

        // An unsaved re-auth draft must not survive the server-side revocation.
        await user.evaluate(`localStorage.setItem(
          "bulletin:draft:reauth:${memberId}:reply:topic:1",
          JSON.stringify({ bodyMd: "private text" })
        )`);

        await loginAs(staff, "admin");
        await waitForSelector(staff, '[data-auth-state="authenticated"]');

        const status = await staff.evaluate<number>(`(async () => {
          const session = await fetch("/api/auth/session", { headers: { accept: "application/json" } }).then((response) => response.json());
          const response = await fetch("/api/staff/members/${memberId}/sessions/revoke", {
            method: "POST",
            headers: { "content-type": "application/json", "x-bulletin-csrf": session.csrfToken },
            body: "{}"
          });
          return response.status;
        })()`);
        expect(status).toBe(200);

        await waitForExpression(
          user,
          'document.documentElement.dataset.visitor === "guest"',
          30_000,
        );
        expect(
          await user.evaluate<number>(
            'Object.keys(localStorage).filter((key) => key.startsWith("bulletin:draft:")).length',
          ),
        ).toBe(0);
      },
    );
  }, 300_000);
});
