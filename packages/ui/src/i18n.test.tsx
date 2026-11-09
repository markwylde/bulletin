import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider, useT } from "./i18n.tsx";

function Button() {
  const t = useT();
  return <span>{t("topic.reply.button")}</span>;
}

function Replies() {
  const t = useT();
  return <span>{t("topic.reply.count", { count: 5 })}</span>;
}

describe("useT", () => {
  test("translates with the provider locale", () => {
    expect(
      renderToStaticMarkup(
        <I18nProvider locale="es" messages={{ "topic.reply.button": "Responder" }}>
          <Button />
        </I18nProvider>,
      ),
    ).toBe("<span>Responder</span>");
  });

  test("formats ICU values", () => {
    expect(
      renderToStaticMarkup(
        <I18nProvider
          locale="fr"
          messages={{ "topic.reply.count": "{count, plural, one {# réponse} other {# réponses}}" }}
        >
          <Replies />
        </I18nProvider>,
      ),
    ).toBe("<span>5 réponses</span>");
  });

  test("applies runtime messages over shipped strings", () => {
    expect(
      renderToStaticMarkup(
        <I18nProvider locale="en" messages={{ "topic.reply.button": "Respond" }}>
          <Button />
        </I18nProvider>,
      ),
    ).toBe("<span>Respond</span>");
  });

  test("fails clearly outside a provider", () => {
    expect(() => renderToStaticMarkup(<Button />)).toThrow("I18nProvider");
  });
});
