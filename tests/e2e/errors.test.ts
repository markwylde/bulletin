import { describe, expect, test } from "bun:test";
import { withPage } from "@bulletin/test-utils/e2e";

// Run against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;

integrationDescribe("E2E page error tracking", () => {
  test("fails the page helper on an uncaught script exception", async () => {
    await expect(
      withPage(
        {
          url: "data:text/html,<script>throw new Error('boom')</script>",
          viewport: "mobile360",
        },
        async () => undefined,
      ),
    ).rejects.toThrow(/boom/);
  }, 30_000);

  test("fails the page helper on an unhandled promise rejection", async () => {
    await expect(
      withPage(
        {
          url: "data:text/html,<script>Promise.reject(new Error('rejected'))</script>",
          viewport: "mobile360",
        },
        async () => undefined,
      ),
    ).rejects.toThrow(/rejected/);
  }, 30_000);
});
