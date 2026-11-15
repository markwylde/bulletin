import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = staffBaseUrl();
const USER_URL = userBaseUrl();

integrationDescribe("staff bans at mobile360", () => {
  test("adds and removes a CIDR ban and shows the member ban notice", async () => {
    const cidr = `198.51.100.${Date.now() % 200}/32`;
    let memberId = "";

    try {
      await withPage(
        { url: `${STAFF_URL}/moderation/bans`, viewport: "mobile360" },
        async (view) => {
          await loginAs(view, "admin");
          await waitForSelector(view, '[data-page="bans"]', 20_000);
          await waitForSelector(view, "[data-ip-ban-cidr]", 20_000);
          await setInputValue(view, "[data-ip-ban-cidr]", cidr);
          await setInputValue(view, "[data-ip-ban-reason]", "E2E network ban");
          await waitForSelector(view, "[data-ip-ban-save]:not([disabled])", 20_000);
          await clickSelector(view, "[data-ip-ban-save]");
          await waitForExpression(
            view,
            `[...document.querySelectorAll('[data-ip-ban-row]')].some(
            (element) => element.textContent?.includes(${JSON.stringify(cidr)})
          )`,
            20_000,
          );

          const id = await view.evaluate<string | null>(`(() => {
          const row = [...document.querySelectorAll('[data-ip-ban-row]')].find(
            (element) => element.textContent?.includes(${JSON.stringify(cidr)})
          );
          return row?.getAttribute('data-ip-ban-row') ?? null;
        })()`);

          if (id === null) {
            throw new Error("Missing the new IP ban");
          }

          await clickSelector(view, `[data-ip-ban-row="${id}"] [data-ip-ban-remove]`);
          await waitForExpression(
            view,
            `document.querySelector('[data-ip-ban-row="${id}"]') === null`,
            20_000,
          );

          memberId = await view.evaluate<string>(`fetch(
          "/api/staff/moderators/members?query=Warned%20Member",
          { credentials: "include", headers: { accept: "application/json" } }
        ).then((response) => response.json()).then((body) => body.members[0]?.id ?? "")`);

          if (memberId === "") {
            throw new Error("Missing the warned-member profile");
          }

          await setInputValue(view, "[data-member-ban-id]", memberId);
          await setInputValue(view, "[data-member-ban-reason]", "E2E member ban");
          await waitForSelector(view, "[data-member-ban-save]:not([disabled])", 20_000);
          await clickSelector(view, "[data-member-ban-save]");
          await waitForSelector(view, '[data-toast-tone="success"]', 20_000);

          expect(
            await view.evaluate<number>(
              "document.documentElement.scrollWidth - document.documentElement.clientWidth",
            ),
          ).toBeLessThanOrEqual(1);
        },
      );

      await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
        await loginAs(view, "warned-member");
        await waitForSelector(view, "[data-ban-notice]:not([hidden])", 20_000);
        expect(await view.evaluate<string>("document.body.innerText")).toContain("E2E member ban");
      });
    } finally {
      if (memberId !== "") {
        await withPage(
          { url: `${STAFF_URL}/moderation/bans`, viewport: "mobile360" },
          async (view) => {
            await loginAs(view, "admin");
            await waitForSelector(view, "[data-member-ban-id]", 20_000);
            await setInputValue(view, "[data-member-ban-id]", memberId);
            await clickSelector(view, "[data-member-ban-unban]");
          },
        ).catch(() => undefined);
      }
    }
  }, 240_000);
});
