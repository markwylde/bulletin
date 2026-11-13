import { describe, expect, test } from "bun:test";
import { waitForExpression, withPage } from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const e2eDescribe = ENABLED ? describe : describe.skip;

e2eDescribe("API documentation page", () => {
  test("renders the generated OpenAPI document at 360 px", async () => {
    await withPage({ url: `${userBaseUrl()}/api-docs`, viewport: "mobile360" }, async (view) => {
      await waitForExpression(
        view,
        `(() => {
            const target = document.querySelector("#api-reference");
            return target !== null && (target.textContent ?? "").includes("List forums");
          })()`,
        30_000,
      );

      const width = await view.evaluate<number>("document.documentElement.clientWidth");
      expect(width).toBe(360);
      expect(
        await view.evaluate<boolean>(`document.body.innerText.includes("API documentation")`),
      ).toBe(true);
    });
  }, 90_000);
});
