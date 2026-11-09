import { describe, expect, test } from "bun:test";
import { SEEDED_PROFILES } from "@bulletin/db/seed";
import { loginAs, loginAsRefused, waitForText, withPage } from "@bulletin/test-utils/e2e";
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

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
    url: userBaseUrl(),
  },
  {
    name: "staff-app",
    url: staffBaseUrl(),
  },
] as const;

const VIEWPORTS = ["mobile360", "desktop"] as const;

for (const app of APPS) {
  integrationDescribe(`${app.name} login`, () => {
    for (const profile of profiles) {
      for (const viewport of VIEWPORTS) {
        test(`${app.name} ${profile.sub} at ${viewport}`, async () => {
          const seeded = SEEDED_PROFILES.find((candidate) => candidate.sub === profile.sub);

          if (seeded === undefined) {
            throw new Error(`No seeded member for profile ${profile.sub}`);
          }

          const refused =
            app.name === "staff-app" &&
            seeded.group !== "administrators" &&
            seeded.group !== "super_moderators";

          await withPage(
            {
              url: app.url,
              viewport,
              ...(refused ? { allowConsoleErrors: [/403.*\/api\/auth\/session/] } : {}),
            },
            async (view) => {
              if (refused) {
                await loginAsRefused(view, profile.sub);
                return;
              }

              await loginAs(view, profile.sub);

              expect(
                await view.evaluate<string | null>(
                  "document.querySelector('[data-auth-state]')?.getAttribute('data-auth-state') ?? null",
                ),
              ).toBe("authenticated");

              await waitForText(view, seeded.name, 30_000);
            },
          );
        }, 90_000);
      }
    }
  });
}
