import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clickSelector,
  loginAs,
  VIEWPORTS,
  type ViewportName,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const FORUM_URL = new URL("/forum/5-off-topic", USER_URL).toString();
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQYlWPQSDnxHx9mGBkKAFtclMHoLjVbAAAAAElFTkSuQmCC";

async function openNewTopicForm(view: Bun.WebView): Promise<void> {
  await waitForSelector(view, "[data-new-topic-form]", 20_000);
  await clickSelector(view, "[data-new-topic] summary");
  await view.evaluate(
    `document.querySelector('[data-new-topic-form] bl-island[data-name="Editor"]')?.scrollIntoView({ block: "center" })`,
  );
  await waitForSelector(view, '[data-new-topic-form] [data-editor-ready="true"]', 20_000);
  await clickSelector(view, '[data-editor-mode="source"]');
  await waitForSelector(view, "[data-new-topic-form] [data-editor-source]", 20_000);
}

async function pasteFile(view: Bun.WebView, name: string): Promise<void> {
  await view.evaluate(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(PNG_BASE64)}), (character) =>
      character.charCodeAt(0),
    );
    const file = new File([bytes], ${JSON.stringify(name)}, { type: "image/png" });
    const data = new DataTransfer();
    data.items.add(file);
    const target = document.querySelector("[data-new-topic-form] [data-editor-source]")
      ?? document.querySelector("[data-new-topic-form] [data-editor]");
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    target?.dispatchEvent(event);
    return true;
  })()`);
}

async function pickFile(view: Bun.WebView, path: string): Promise<void> {
  const document = await view.cdp<{ root: { nodeId: number } }>("DOM.getDocument", {});
  const input = await view.cdp<{ nodeId: number }>("DOM.querySelector", {
    nodeId: document.root.nodeId,
    selector: "[data-editor-file-input]",
  });

  await view.cdp("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [path] });
}

integrationDescribe("editor attachments", () => {
  for (const viewportName of ["mobile360", "desktop"] as ViewportName[]) {
    const viewport = VIEWPORTS[viewportName];

    test(`pastes and uploads a file at ${viewportName} (${viewport.width}x${viewport.height})`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "bulletin-attachment-"));
      const filePath = join(directory, "picked.png");
      await writeFile(filePath, Buffer.from(PNG_BASE64, "base64"));

      try {
        await withPage({ url: USER_URL, viewport: viewportName }, async (view) => {
          await loginAs(view, "member-1");
          await view.evaluate('fetch("/api/test/reset-rate-buckets", { method: "POST" })');
          await view.navigate(FORUM_URL);
          await openNewTopicForm(view);

          await waitForSelector(view, "[data-editor-attach]:not([disabled])", 20_000);
          await pasteFile(view, "pasted.png");
          await waitForSelector(view, '[data-upload-status="ready"]', 90_000);
          await waitForExpression(
            view,
            'document.querySelector("[data-editor-source]")?.value.includes("attachment:") === true',
            20_000,
          );

          await pickFile(view, filePath);
          await waitForExpression(
            view,
            'document.querySelectorAll(\'[data-upload-name="picked.png"][data-upload-status="ready"]\').length === 1',
            90_000,
          );

          const value = await view.evaluate<string>(
            'document.querySelector("[data-editor-source]")?.value ?? ""',
          );
          expect(value.match(/attachment:\d+/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
          expect(
            await view.evaluate<number>(
              "document.documentElement.scrollWidth - document.documentElement.clientWidth",
            ),
          ).toBeLessThanOrEqual(1);
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 180_000);
  }
});
