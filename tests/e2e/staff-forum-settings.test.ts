import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl } from "@bulletin/test-utils/urls";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = staffBaseUrl();

/**
 * A stack that was seeded before `announcements` joined the seed keeps the code default
 * (off, ADR 0010) because a rerun of the seed modules is a no-op. Turn it on for every group
 * so this test is not coupled to the age of the database volume; a freshly seeded stack
 * already has it on and this is a no-op.
 */
async function ensureAnnouncementsFlag(view: Bun.WebView): Promise<void> {
  const enabled = await view.evaluate<boolean>(
    `fetch("/api/staff/features", { credentials: "include" })
      .then((response) => response.json())
      .then((body) => body?.flags?.announcements === true)`,
  );

  if (enabled) {
    return;
  }

  const status = await view.evaluate<number>(`(async () => {
    const token = sessionStorage.getItem("bulletin_csrf_token");
    const response = await fetch("/api/staff/flags", {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(token === null ? {} : { "x-bulletin-csrf": token }),
      },
      body: JSON.stringify({
        key: "announcements",
        rules: [{
          type: "group",
          groups: [
            "guests", "members", "regulars", "vip", "moderators",
            "super_moderators", "administrators", "banned",
          ],
          value: true,
        }],
      }),
    });

    return response.status;
  })()`);

  if (status !== 200) {
    throw new Error(`Could not enable the announcements flag (status ${status})`);
  }
}

integrationDescribe("staff forum settings, prefixes and announcements", () => {
  test("edits forum settings, creates a prefix and publishes an announcement", async () => {
    await withPage({ url: `${STAFF_URL}/forums`, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await ensureAnnouncementsFlag(view);
      await waitForSelector(view, '[data-page="forums"]');
      await waitForSelector(view, "[data-forum-settings]", 20_000);
      await clickSelector(view, "[data-forum-settings]");
      await waitForSelector(view, "[data-forum-editor]");
      await setInputValue(view, '[data-forum-setting="description"]', "E2E forum description");
      await setInputValue(view, '[data-forum-setting="rules"]', "E2E rules");
      await clickSelector(view, "[data-forum-settings-save]");
      await waitForSelector(view, '[data-toast-tone="success"]');

      await view.navigate(`${STAFF_URL}/forums/prefixes`);
      await waitForSelector(view, '[data-page="prefixes"]');
      const stamp = Date.now();
      const key = `e2e_prefix_${stamp}`;
      await setInputValue(view, '[data-prefix-field="key"]', key);
      await setInputValue(view, '[data-prefix-field="label-en"]', `E2E Prefix ${stamp}`);
      await clickSelector(view, "[data-prefix-save]");
      await waitForSelector(view, `[data-prefix-row="${key}"]`, 20_000);

      await view.navigate(`${STAFF_URL}/announcements`);
      await waitForSelector(view, '[data-page="announcements"]');
      await setInputValue(view, '[data-announcement-field="title"]', `E2E Notice ${stamp}`);
      await setInputValue(view, '[data-announcement-field="body"]', "E2E notice body");
      await clickSelector(view, "[data-announcement-save]");
      await waitForExpression(
        view,
        `[...document.querySelectorAll('[data-announcement-list] strong')].some(
          (node) => (node.textContent ?? "").includes(${JSON.stringify(`E2E Notice ${stamp}`)})
        )`,
        20_000,
      );

      expect(
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
      ).toBe(true);
    });
  }, 180_000);
});
