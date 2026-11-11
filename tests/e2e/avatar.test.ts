import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";
import sharp from "sharp";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();

integrationDescribe("avatar crop", () => {
  test("uploads and crops an avatar at 360 px", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bulletin-avatar-"));
    const filePath = join(directory, "avatar.jpg");
    await writeFile(
      filePath,
      await sharp({
        create: { width: 640, height: 480, channels: 3, background: "#336699" },
      })
        .jpeg()
        .toBuffer(),
    );

    try {
      await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
        await loginAs(view, "member-1");
        await view.navigate(new URL("/account", USER_URL).toString());
        await waitForSelector(view, "[data-avatar-file]", 20_000);

        const document = await view.cdp<{ root: { nodeId: number } }>("DOM.getDocument", {});
        const input = await view.cdp<{ nodeId: number }>("DOM.querySelector", {
          nodeId: document.root.nodeId,
          selector: "[data-avatar-file]",
        });
        await view.cdp("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [filePath] });

        await waitForSelector(view, "[data-avatar-save]:not([disabled])", 20_000);
        await setInputValue(view, "[data-avatar-zoom]", "2");
        await clickSelector(view, "[data-avatar-save]");
        await waitForSelector(view, "[data-account-avatar-img]", 30_000);

        const src = await view.evaluate<string | null>(
          'document.querySelector("[data-account-avatar-img]")?.getAttribute("src") ?? null',
        );
        expect(src).toMatch(/^\/avatars\/\d+\/[0-9a-f]{64}-lg\.webp$/);
        expect(
          await view.evaluate<number>(
            "document.documentElement.scrollWidth - document.documentElement.clientWidth",
          ),
        ).toBeLessThanOrEqual(1);
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
