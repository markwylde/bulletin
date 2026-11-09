import { describe, test } from "bun:test";
import { type Locale, t } from "@bulletin/i18n";
import { waitForText, withPage } from "@bulletin/test-utils/e2e";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;

const LOCALES: Locale[] = ["en", "es", "fr"];

const APPS = [
  {
    name: "user-app",
    url: Bun.env.BULLETIN_BASE_URL ?? "http://bulletin.localhost:8080",
    key: "user.placeholder.body" as const,
  },
  {
    name: "staff-app",
    url: Bun.env.BULLETIN_STAFF_BASE_URL ?? "http://staff.bulletin.localhost:8080",
    key: "staff.placeholder.body" as const,
  },
] as const;

for (const app of APPS) {
  integrationDescribe(`${app.name} locales`, () => {
    for (const locale of LOCALES) {
      test(`renders ${locale}`, async () => {
        await withPage(
          { url: `${app.url}/?lang=${locale}`, viewport: "mobile360" },
          async (view) => {
            await waitForText(view, t(locale, app.key));
          },
        );
      }, 90_000);
    }
  });
}
