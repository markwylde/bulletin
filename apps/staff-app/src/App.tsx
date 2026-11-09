import { I18nProvider, useT } from "@bulletin/ui";
import { STAFF_CATALOGS } from "./catalogs.ts";
import { localeFromRequest } from "./locale.ts";
import "./styles.css";

function Content() {
  const t = useT();

  return (
    <main>
      <h1>{t("staff.placeholder.title")}</h1>
      <p>{t("staff.placeholder.body")}</p>
    </main>
  );
}

export function App() {
  const locale = localeFromRequest(window.location.search, document.cookie);

  return (
    <I18nProvider locale={locale} messages={STAFF_CATALOGS[locale]}>
      <Content />
    </I18nProvider>
  );
}
