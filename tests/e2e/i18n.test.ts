import { describe, test } from "bun:test";
import type { Locale } from "@bulletin/i18n";
import { waitForText, withPage } from "@bulletin/test-utils/e2e";
import staffEn from "../../apps/staff-app/i18n/en.json";
import staffEs from "../../apps/staff-app/i18n/es.json";
import staffFr from "../../apps/staff-app/i18n/fr.json";
import userEn from "../../apps/user-app/i18n/en.json";
import userEs from "../../apps/user-app/i18n/es.json";
import userFr from "../../apps/user-app/i18n/fr.json";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;

const LOCALES: Locale[] = ["en", "es", "fr"];

const APPS = [
  {
    name: "user-app",
    url: Bun.env.BULLETIN_BASE_URL ?? "http://bulletin.localhost:8080",
    key: "user.placeholder.body",
    catalogs: { en: userEn, es: userEs, fr: userFr },
  },
  {
    name: "staff-app",
    url: Bun.env.BULLETIN_STAFF_BASE_URL ?? "http://staff.bulletin.localhost:8080",
    key: "staff.placeholder.body",
    catalogs: { en: staffEn, es: staffEs, fr: staffFr },
  },
] as const;

for (const app of APPS) {
  integrationDescribe(`${app.name} locales`, () => {
    for (const locale of LOCALES) {
      test(`renders ${locale}`, async () => {
        await withPage(
          { url: `${app.url}/?lang=${locale}`, viewport: "mobile360" },
          async (view) => {
            await waitForText(view, app.catalogs[locale][app.key]);
          },
        );
      }, 90_000);
    }
  });
}
