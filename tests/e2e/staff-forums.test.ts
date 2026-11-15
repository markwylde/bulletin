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

function optionValue(title: string): string {
  return `(() => {
    const select = document.querySelector('[data-forum-create-parent]');
    if (!(select instanceof HTMLSelectElement)) return "";
    return [...select.options].find((option) => (option.textContent ?? "").includes(${JSON.stringify(title)}))?.value ?? "";
  })()`;
}

async function createForum(
  view: Bun.WebView,
  title: string,
  parentTitle: string | null,
  type: "category" | "forum" = "forum",
): Promise<void> {
  await waitForSelector(view, "[data-forum-create]", 20_000);
  await setInputValue(view, '[data-forum-create-field="title"]', title);
  await setInputValue(view, "[data-forum-create-type]", type);

  if (parentTitle !== null) {
    const parentId = await view.evaluate<string>(optionValue(parentTitle));

    expect(parentId).not.toBe("");
    await setInputValue(view, "[data-forum-create-parent]", parentId);
  }

  await clickSelector(view, "[data-forum-create-submit]");
  await waitForSelector(view, `[data-forum-title="${title}"]`, 20_000);
  await waitForExpression(view, optionValue(title), 20_000);
}

integrationDescribe("staff forum manager", () => {
  for (const viewport of ["mobile360", "desktop"] as const) {
    test(`creates, drags and deletes forums at ${viewport}`, async () => {
      await withPage({ url: `${STAFF_URL}/forums`, viewport }, async (view) => {
        await loginAs(view, "admin");
        await waitForSelector(view, '[data-page="forums"]');

        const stamp = Date.now();
        const category = `E2E Category ${stamp}`;
        const target = `E2E Target ${stamp}`;
        const moving = `E2E Moving ${stamp}`;

        await createForum(view, category, null, "category");
        await createForum(view, target, category);
        await createForum(view, moving, "Community");

        const sourceId = await view.evaluate<string>(
          `document.querySelector('[data-forum-title="${moving}"]')?.getAttribute('data-forum-row') ?? ""`,
        );
        const targetId = await view.evaluate<string>(
          `document.querySelector('[data-forum-title="${target}"]')?.getAttribute('data-forum-row') ?? ""`,
        );

        expect(sourceId).not.toBe("");
        expect(targetId).not.toBe("");

        await view.evaluate(`(() => {
          const source = document.querySelector('[data-forum-row="${sourceId}"]');
          source?.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }));
        })()`);
        await Bun.sleep(100);
        await view.evaluate(`(() => {
          const target = document.querySelector('[data-forum-row="${targetId}"]');
          target?.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true }));
          target?.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true }));
        })()`);

        await waitForExpression(
          view,
          `(() => {
            const source = document.querySelector('[data-forum-row="${sourceId}"]');
            const target = document.querySelector('[data-forum-row="${targetId}"]');
            if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement)) return false;
            return parseInt(source.style.paddingInlineStart) > parseInt(target.style.paddingInlineStart);
          })()`,
          20_000,
        );

        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
          ),
        ).toBe(true);

        await clickSelector(view, `[data-forum-delete="${sourceId}"]`);
        await waitForSelector(view, "[data-confirm-dialog][open] [data-confirm-action]");
        await clickSelector(view, "[data-confirm-dialog][open] [data-confirm-action]");
        await waitForExpression(
          view,
          `!document.querySelector('[data-forum-row="${sourceId}"]')`,
          20_000,
        );
      });
    }, 180_000);
  }
});
