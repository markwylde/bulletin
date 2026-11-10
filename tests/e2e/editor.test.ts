import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
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
const EDITOR_URL = new URL("/_demo/editor", USER_URL).toString();
const VIEWPORT_NAMES = Object.keys(VIEWPORTS) as ViewportName[];

async function openEditor(view: Bun.WebView): Promise<void> {
  await view.navigate(EDITOR_URL);
  await waitForSelector(view, "[data-editor]", 20_000);
  await waitForSelector(view, "[data-editor-wysiwyg] .ProseMirror", 30_000);
}

async function clearEditorDraft(view: Bun.WebView): Promise<void> {
  await view.evaluate(`(async () => {
    const session = await fetch("/api/auth/session").then((response) => response.json());
    await fetch("/api/me/drafts?contextKey=demo%3Aeditor", {
      method: "DELETE",
      headers: { "x-bulletin-csrf": session.csrfToken ?? "" },
    });
    return true;
  })()`);
}

async function switchToSource(view: Bun.WebView): Promise<void> {
  await clickSelector(view, '[data-editor-mode="source"]');
  await waitForSelector(view, "[data-editor-source]");
}

async function sourceValue(view: Bun.WebView): Promise<string> {
  return view.evaluate<string>('document.querySelector("[data-editor-source]")?.value ?? ""');
}

integrationDescribe("post editor", () => {
  for (const viewportName of VIEWPORT_NAMES) {
    test(`keeps the toolbar visible without horizontal scrolling at ${viewportName}`, async () => {
      await withPage({ url: EDITOR_URL, viewport: viewportName }, async (view) => {
        await waitForSelector(view, "[data-editor-wysiwyg] .ProseMirror", 30_000);
        await waitForSelector(view, "[data-editor-toolbar]");

        const toolbarVisible = await view.evaluate<boolean>(`(() => {
          const toolbar = document.querySelector("[data-editor-toolbar]");
          if (!(toolbar instanceof HTMLElement)) return false;
          const rect = toolbar.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= window.innerHeight + 1 &&
            rect.left >= 0 && rect.right <= window.innerWidth + 1;
        })()`);

        expect(toolbarVisible).toBe(true);
        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
          ),
        ).toBe(true);
        expect(
          await view.evaluate<number>(
            'document.querySelectorAll("[data-editor-toolbar] button").length',
          ),
        ).toBeGreaterThanOrEqual(10);

        if (viewportName === "mobile360") {
          await view.evaluate(
            'document.querySelector("[data-editor-wysiwyg] .ProseMirror")?.focus()',
          );
          // A phone keyboard shrinks the visual viewport; the sticky toolbar must stay visible.
          await view.cdp("Emulation.setDeviceMetricsOverride", {
            width: 360,
            height: 420,
            deviceScaleFactor: 1,
            mobile: true,
          });
          await view.cdp("Input.insertText", { text: "Typing on a phone keyboard" });
          await Bun.sleep(100);

          expect(
            await view.evaluate<boolean>(`(() => {
              const toolbar = document.querySelector("[data-editor-toolbar]");
              if (!(toolbar instanceof HTMLElement)) return false;
              const rect = toolbar.getBoundingClientRect();
              return rect.top >= 0 && rect.bottom <= window.innerHeight + 1;
            })()`),
          ).toBe(true);

          await view.evaluate("window.scrollTo(0, document.body.scrollHeight)");
          await Bun.sleep(50);
          expect(
            await view.evaluate<boolean>(`(() => {
              const toolbar = document.querySelector("[data-editor-toolbar]");
              if (!(toolbar instanceof HTMLElement)) return false;
              const rect = toolbar.getBoundingClientRect();
              return rect.top >= 0 && rect.bottom <= window.innerHeight + 1;
            })()`),
          ).toBe(true);
        }
      });
    }, 120_000);
  }

  test("switching modes preserves an untouched source verbatim", async () => {
    await withPage({ url: EDITOR_URL, viewport: "mobile360" }, async (view) => {
      await waitForSelector(view, "[data-editor-wysiwyg] .ProseMirror", 30_000);
      await switchToSource(view);
      const original = await sourceValue(view);

      expect(original).toContain(":::disabled-plugin");
      await clickSelector(view, '[data-editor-mode="wysiwyg"]');
      await waitForSelector(view, "[data-editor-wysiwyg] .ProseMirror", 30_000);
      await switchToSource(view);

      expect(await sourceValue(view)).toBe(original);

      await setInputValue(view, "[data-editor-source]", `New intro\n\n${original}`);
      await clickSelector(view, '[data-editor-mode="wysiwyg"]');
      await waitForSelector(view, "[data-editor-wysiwyg] .ProseMirror", 30_000);
      await switchToSource(view);

      expect(await sourceValue(view)).toContain(original);
      expect(await sourceValue(view)).toContain("New intro");
    });
  }, 120_000);

  test("renders emoticons, spoilers and mentions as custom editor nodes", async () => {
    await withPage({ url: EDITOR_URL, viewport: "mobile360" }, async (view) => {
      await waitForSelector(view, "[data-editor-wysiwyg] .ProseMirror", 30_000);
      await switchToSource(view);
      const value = ":smile: ||secret|| @[Regular Member One](member:5)";
      await setInputValue(view, "[data-editor-source]", value);
      await clickSelector(view, '[data-editor-mode="wysiwyg"]');
      await waitForSelector(view, "[data-editor-wysiwyg] img.emoticon", 30_000);
      await waitForSelector(view, "[data-editor-wysiwyg] span.spoiler", 30_000);
      await waitForSelector(view, "[data-editor-wysiwyg] a[data-mention-id]", 30_000);
      await switchToSource(view);

      expect(await sourceValue(view)).toContain(":smile:");
      expect(await sourceValue(view)).toContain("||secret||");
      expect(await sourceValue(view)).toContain("@[Regular Member One](member:5)");
    });
  }, 120_000);

  test("the emoticon picker inserts its code", async () => {
    await withPage({ url: EDITOR_URL, viewport: "mobile360" }, async (view) => {
      await waitForSelector(view, "[data-editor-wysiwyg] .ProseMirror", 30_000);
      await clickSelector(view, "[data-editor-emoticon]");
      await waitForSelector(view, '[data-emoticon-code="smile"]');
      await clickSelector(view, '[data-emoticon-code="smile"]');
      await switchToSource(view);

      expect(await sourceValue(view)).toContain(":smile:");
    });
  }, 120_000);

  test("mention autocomplete suggests members and inserts the name", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-1");
      await openEditor(view);

      await view.evaluate('document.querySelector("[data-editor-wysiwyg] .ProseMirror")?.focus()');
      await view.cdp("Input.insertText", { text: "@Reg" });
      await waitForSelector(view, "[data-mention-list] [data-mention-id]", 10_000);
      await waitForExpression(
        view,
        'document.body.innerText.includes("Regular Member One")',
        10_000,
      );
      await clickSelector(view, "[data-mention-list] [data-mention-id]");
      await switchToSource(view);

      expect(await sourceValue(view)).toContain("@[Regular Member One](member:");
    });
  }, 180_000);

  test("source-mode mention autocomplete replaces the typed prefix", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-1");
      await openEditor(view);
      await switchToSource(view);

      await view.evaluate('document.querySelector("[data-editor-source]")?.focus()');
      await view.cdp("Input.insertText", { text: "@Reg" });
      await waitForSelector(view, "[data-mention-list] [data-mention-id]", 10_000);
      await waitForExpression(
        view,
        'document.body.innerText.includes("Regular Member One")',
        10_000,
      );
      await clickSelector(view, "[data-mention-list] [data-mention-id]");
      await waitForExpression(
        view,
        'document.querySelector("[data-editor-source]")?.value.includes("@[Regular Member One](member:") === true',
        10_000,
      );

      const value = await sourceValue(view);
      expect(value).toContain("@[Regular Member One](member:");
      expect(value).not.toContain("@Reg");
    });
  }, 180_000);

  test("offers a saved draft on a second browser profile", async () => {
    const body = "A saved **draft** reply";

    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-1");
      await clearEditorDraft(view);
      await openEditor(view);
      await switchToSource(view);
      await setInputValue(view, "[data-editor-source]", body);
      await waitForSelector(view, '[data-draft-status="saved"]', 15_000);
    });

    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-1");
      await openEditor(view);
      await waitForSelector(view, "[data-draft-offer]", 15_000);
      await clickSelector(view, "[data-draft-restore]");
      await waitForExpression(
        view,
        'document.querySelector("[data-draft-offer]") === null',
        10_000,
      );
      await switchToSource(view);

      expect(await sourceValue(view)).toBe(body);

      await view.evaluate(`(async () => {
        const session = await fetch("/api/auth/session").then((response) => response.json());
        await fetch("/api/me/drafts?contextKey=demo%3Aeditor", {
          method: "DELETE",
          headers: { "x-bulletin-csrf": session.csrfToken ?? "" },
        });
        return true;
      })()`);
    });
  }, 240_000);

  test("reverting to the original content clears the saved draft", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-1");
      await clearEditorDraft(view);
      await openEditor(view);
      await switchToSource(view);
      const original = await sourceValue(view);

      await setInputValue(view, "[data-editor-source]", "Temporary draft");
      await waitForSelector(view, '[data-draft-status="saved"]', 15_000);

      await setInputValue(view, "[data-editor-source]", original);
      await Bun.sleep(2_500);
      await waitForSelector(view, '[data-draft-status="saved"]', 15_000);
    });

    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-1");
      await openEditor(view);
      await Bun.sleep(1_000);

      expect(
        await view.evaluate<boolean>('document.querySelector("[data-draft-offer]") === null'),
      ).toBe(true);
    });
  }, 240_000);

  test("Cmd/Ctrl+B applies bold formatting from the keyboard", async () => {
    await withPage({ url: EDITOR_URL, viewport: "mobile360" }, async (view) => {
      await waitForSelector(view, "[data-editor-wysiwyg] .ProseMirror", 30_000);
      await view.evaluate('document.querySelector("[data-editor-wysiwyg] .ProseMirror")?.focus()');

      for (const type of ["keyDown", "keyUp"] as const) {
        await view.cdp("Input.dispatchKeyEvent", {
          type,
          modifiers: 4,
          key: "b",
          code: "KeyB",
          windowsVirtualKeyCode: 66,
          nativeVirtualKeyCode: 66,
        });
      }

      await view.cdp("Input.insertText", { text: "bold" });
      await Bun.sleep(400);
      await switchToSource(view);

      expect(await sourceValue(view)).toContain("**bold**");
    });
  }, 120_000);

  test("exposes translated accessible names and keyboard-focusable toolbar controls", async () => {
    await withPage({ url: EDITOR_URL, viewport: "mobile360" }, async (view) => {
      await waitForSelector(view, "[data-editor-toolbar]", 30_000);
      await waitForSelector(view, "[data-editor-wysiwyg] .ProseMirror", 30_000);

      const controls = await view.evaluate<Array<{ label: string; tabIndex: number }>>(
        `[...document.querySelectorAll("[data-editor-toolbar] button")].map((button) => ({
          label: button.getAttribute("aria-label") ?? "",
          tabIndex: button.tabIndex,
        }))`,
      );

      expect(controls.length).toBeGreaterThanOrEqual(10);
      expect(controls.every((control) => control.label.trim().length > 0)).toBe(true);
      expect(controls.every((control) => control.tabIndex >= 0)).toBe(true);
      expect(
        await view.evaluate<string>(
          'document.querySelector("[data-editor-wysiwyg] .ProseMirror")?.getAttribute("aria-label") ?? ""',
        ),
      ).not.toBe("");
      expect(
        await view.evaluate<string>(
          'document.querySelector("[data-editor-toolbar]")?.getAttribute("role") ?? ""',
        ),
      ).toBe("toolbar");
      expect(
        await view.evaluate<string>(
          'document.querySelector("[data-editor-mode-announcement]")?.getAttribute("aria-live") ?? ""',
        ),
      ).toBe("polite");
    });
  }, 120_000);
});
