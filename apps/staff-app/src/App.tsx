import { t } from "@bulletin/i18n";
import { localeFromRequest } from "./locale.ts";
import "./styles.css";

export function App() {
  const locale = localeFromRequest(window.location.search, document.cookie);

  return (
    <main>
      <h1>{t(locale, "staff.placeholder.title")}</h1>
      <p>{t(locale, "staff.placeholder.body")}</p>
    </main>
  );
}
