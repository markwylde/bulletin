import { describe, expect, test } from "bun:test";
import {
  GROUP_SETTINGS,
  promotionCriteria,
  SECTION_LABEL_KEYS,
} from "@bulletin/domain/permissions";
import { type Catalog, LOCALES, type Locale } from "@bulletin/i18n";
import { STAFF_CATALOGS } from "./catalogs.ts";

const REQUIRED_KEYS = [
  "staff.nav.dashboard",
  "staff.nav.adminLog",
  "staff.nav.boardSettings",
  "staff.nav.strings",
  "staff.nav.flags",
  "staff.settings.board.title",
  "staff.log.title",
  "staff.strings.title",
  "staff.flags.title",
  "staff.flags.intro",
  "staff.flags.key",
  "staff.flags.description",
  "staff.flags.owner",
  "staff.flags.default",
  "staff.flags.rules",
  "staff.flags.ageDays",
  "staff.flags.status",
  "staff.flags.edit",
  "staff.flags.saveRules",
  "staff.flags.saved",
  "staff.flags.rule.group",
  "staff.flags.rule.percentage",
  "staff.flags.rule.groups",
  "staff.flags.rule.percent",
  "staff.flags.rule.on",
  "staff.flags.summary.groupOn",
  "staff.flags.summary.groupOff",
  "staff.flags.summary.percentOn",
  "staff.flags.summary.percentOff",
  "staff.flags.log.title",
  "staff.flags.log.change",
  "staff.flags.group.guests",
  "staff.flags.group.superModerators",
  "staff.nav.groups",
  "staff.nav.groupSettings",
  "staff.nav.permissions",
  "staff.nav.memberGroups",
  "staff.nav.moderators",
  "staff.nav.promotions",
  "staff.groups.titlePage",
  "staff.groups.settings.title",
  "staff.masks.title",
  "staff.memberGroups.title",
  "staff.moderators.title",
  "staff.promotions.title",
  "ui.form.error.required",
  "ui.form.error.min",
  "ui.form.error.max",
  "ui.table.empty",
  "ui.dialog.confirm",
  "ui.toast.dismiss",
  "staff.nav.deadLetters",
  "staff.deadLetters.title",
  "staff.deadLetters.intro",
  "staff.deadLetters.retry",
] as const;

describe("staff catalogs", () => {
  test("ships the same keys in English, Spanish and French", () => {
    const englishKeys = Object.keys(STAFF_CATALOGS.en).sort();

    for (const locale of LOCALES) {
      expect(Object.keys(STAFF_CATALOGS[locale]).sort()).toEqual(englishKeys);
    }
  });

  test("includes the shell, section and shared building-block strings", () => {
    for (const key of REQUIRED_KEYS) {
      for (const locale of LOCALES) {
        expect(STAFF_CATALOGS[locale][key]).toBeString();
        expect(STAFF_CATALOGS[locale][key]?.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("translates every group-settings, section, power and criterion label", () => {
    const keys = new Set<string>();

    for (const definition of GROUP_SETTINGS) {
      keys.add(definition.labelKey);
    }

    for (const key of Object.values(SECTION_LABEL_KEYS)) {
      keys.add(key);
    }

    for (const criterion of promotionCriteria.list()) {
      keys.add(criterion.labelKey);
    }

    expect(keys.size).toBeGreaterThan(50);

    for (const key of keys) {
      for (const locale of LOCALES) {
        const catalog: Catalog = STAFF_CATALOGS[locale];
        expect(catalog[key]?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  test("ships every flags-section string in all three locales", () => {
    const catalogs: Readonly<Record<Locale, Catalog>> = STAFF_CATALOGS;
    const flagsKeys = Object.keys(STAFF_CATALOGS.en).filter(
      (key) => key === "staff.nav.flags" || key.startsWith("staff.flags."),
    );

    expect(flagsKeys.length).toBeGreaterThanOrEqual(50);

    for (const locale of LOCALES) {
      for (const key of flagsKeys) {
        expect(catalogs[locale][key]?.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

const REQUIRED_REACTION_REPUTATION_KEYS = [
  "staff.nav.reactions",
  "staff.nav.memberReputation",
  "staff.reactions.title",
  "staff.reactions.edit",
  "staff.reactions.save",
  "staff.reactions.duplicate",
  "staff.reactions.inUse",
  "staff.reactions.invalid",
  "staff.reputation.title",
  "staff.reputation.entries.title",
  "staff.reputation.total",
  "staff.reputation.recount",
  "staff.reputation.remove",
  "staff.reputation.confirm.title",
  "staff.settings.board.section.reputation",
  "staff.settings.board.reactionsAffectReputation",
  "staff.settings.board.reputationDisplay",
  "staff.settings.board.reputationLabel.respected",
  "reaction.label.like",
  "reaction.label.angry",
] as const;

describe("reaction and reputation staff catalogs", () => {
  test("translate every reaction and reputation manager string", () => {
    for (const locale of LOCALES) {
      for (const key of REQUIRED_REACTION_REPUTATION_KEYS) {
        expect(STAFF_CATALOGS[locale][key]?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});
