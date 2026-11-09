import { describe, expect, test } from "bun:test";
import { loginAs, withPage } from "@bulletin/test-utils/e2e";

// Run against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;

interface MockConfig {
  readonly users?: readonly { readonly sub: string }[];
}

const config = Bun.YAML.parse(
  await Bun.file(new URL("../../darkauth-mock.yaml", import.meta.url)).text(),
) as MockConfig;
const profiles = config.users ?? [];

const APPS = [
  {
    name: "user-app",
    url: Bun.env.BULLETIN_BASE_URL ?? "http://bulletin.localhost:8080",
  },
  {
    name: "staff-app",
    url: Bun.env.BULLETIN_STAFF_BASE_URL ?? "http://staff.bulletin.localhost:8080",
  },
] as const;

const VIEWPORTS = ["mobile360", "desktop"] as const;

for (const app of APPS) {
  integrationDescribe(`${app.name} login`, () => {
    for (const profile of profiles) {
      for (const viewport of VIEWPORTS) {
        test(`logs in as ${profile.sub} at ${viewport}`, async () => {
          await withPage({ url: app.url, viewport }, async (view) => {
            await loginAs(view, profile.sub);

            expect(
              await view.evaluate<string | null>(
                "document.querySelector('[data-auth-state]')?.getAttribute('data-auth-state') ?? null",
              ),
            ).toBe("authenticated");
          });
        }, 90_000);
      }
    }
  });
}
