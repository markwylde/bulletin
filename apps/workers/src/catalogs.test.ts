import { describe, expect, test } from "bun:test";
import { LOCALES, type Locale } from "@bulletin/i18n";
import en from "../i18n/merged/en.json";
import es from "../i18n/merged/es.json";
import fr from "../i18n/merged/fr.json";

const CATALOGS = { en, es, fr } as const satisfies Record<Locale, Record<string, string>>;

const REQUIRED_EMAIL_KEYS = [
  "email.subject.topic.reply",
  "email.subject.topic.created",
  "email.subject.post.mention",
  "email.subject.post.quote",
  "email.subject.reaction.added",
  "email.subject.member.promoted",
  "email.body.topic.reply",
  "email.body.topic.created",
  "email.body.post.mention",
  "email.body.post.quote",
  "email.body.reaction.added",
  "email.body.member.promoted",
  "email.greeting",
  "email.fallbackName",
  "email.fallbackActor",
  "email.open",
  "email.unsubscribe",
  "digest.subject.daily",
  "digest.subject.weekly",
  "digest.intro.daily",
  "digest.intro.weekly",
  "digest.greeting",
  "digest.item",
  "digest.unsubscribe",
] as const;

describe("worker notification catalogs", () => {
  test("ships the same keys in every locale", () => {
    const english = Object.keys(CATALOGS.en).sort();

    for (const locale of LOCALES) {
      expect(Object.keys(CATALOGS[locale]).sort()).toEqual(english);
    }
  });

  test("translates every notification email and digest string", () => {
    for (const locale of LOCALES) {
      for (const key of REQUIRED_EMAIL_KEYS) {
        expect(CATALOGS[locale][key]?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});
