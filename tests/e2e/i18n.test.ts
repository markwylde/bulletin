import { describe, expect, test } from "bun:test";
import type { Locale } from "@bulletin/i18n";
import { loginAs, waitForText, withPage } from "@bulletin/test-utils/e2e";
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";
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
    url: userBaseUrl(),
    key: "auth.login",
    catalogs: { en: userEn, es: userEs, fr: userFr },
  },
  {
    name: "staff-app",
    url: staffBaseUrl(),
    key: "staff.login.body",
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

const USER_URL = userBaseUrl();
const STAFF_URL = staffBaseUrl();

integrationDescribe("member locale", () => {
  for (const viewport of ["mobile360", "desktop"] as const) {
    test(`renders the saved member locale on ${viewport}`, async () => {
      await withPage({ url: USER_URL, viewport }, async (view) => {
        await loginAs(view, "member-fr");
        await waitForText(view, userFr["auth.logout"]);
        expect(await view.evaluate<string>("document.documentElement.lang")).toBe("fr");
      });
    }, 120_000);
  }

  test("renders the member locale in the staff app too", async () => {
    // The shared admin's locale is global state: always put it back, or every later admin
    // test (in this file order or another) runs in French.
    const setAdminLocale = (locale: Locale) =>
      withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
        await loginAs(view, "admin");
        const session = await view.evaluate<{ readonly csrfToken: string | null }>(
          "fetch('/api/auth/session').then((response) => response.json())",
        );
        const saved = await view.evaluate<boolean>(
          `fetch('/api/me/locale', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-bulletin-csrf': ${JSON.stringify(session.csrfToken ?? "")} }, body: JSON.stringify({ locale: ${JSON.stringify(locale)} }) }).then((response) => response.ok)`,
        );
        expect(saved).toBe(true);
      });

    await setAdminLocale("fr");

    try {
      await withPage({ url: STAFF_URL, viewport: "mobile360" }, async (view) => {
        await loginAs(view, "admin");
        await waitForText(view, staffFr["staff.dashboard.title"]);
        expect(await view.evaluate<string>("document.documentElement.lang")).toBe("fr");
      });
    } finally {
      await setAdminLocale("en");
    }
  }, 180_000);
});
