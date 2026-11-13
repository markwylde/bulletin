import { describe, expect, test } from "bun:test";
import { createServerT, LOCALES } from "@bulletin/i18n";
import { USER_CATALOGS } from "./catalogs.ts";

const REQUIRED_NOTIFICATION_KEYS = [
  "notifications.title",
  "notifications.intro",
  "notifications.markAll",
  "notifications.allRead",
  "notifications.readFailed",
  "notifications.section.today",
  "notifications.section.week",
  "notifications.section.earlier",
  "notifications.someone",
  "notification.text.topic.reply",
  "notification.text.topic.replyMany",
  "notification.text.topic.created",
  "notification.text.post.mention",
  "notification.text.post.mentionMany",
  "notification.text.post.quote",
  "notification.text.post.quoteMany",
  "notification.text.reaction.added",
  "notification.text.reaction.addedMany",
  "notification.text.reputation.given",
  "notification.text.reputation.givenMany",
  "notification.text.member.promoted",
  "notification.text.friend.accepted",
  "notification.text.badge.awarded",
  "notification.text.post.approved",
  "notification.text.report.resolved",
  "notification.text.report.rejected",
  "notification.text.warning.issued",
  "notification.preferences.title",
  "notification.preferences.intro",
  "notification.preferences.inApp",
  "notification.preferences.email",
  "notification.preferences.digest",
  "notification.preferences.digestDaily",
  "notification.preferences.digestWeekly",
  "notification.preferences.digestOff",
  "notification.preferences.saved",
  "notification.preferences.saveFailed",
  "notification.preferences.open",
  "notification.type.topic.reply",
  "notification.type.topic.created",
  "notification.type.post.mention",
  "notification.type.post.quote",
  "notification.type.reaction.added",
  "notification.type.reputation.given",
  "notification.type.member.promoted",
  "notification.type.friend.accepted",
  "notification.type.badge.awarded",
  "notification.type.post.approved",
  "notification.type.report.resolved",
  "notification.type.report.rejected",
  "notification.type.warning.issued",
  "realtime.newReplyOne",
  "realtime.newReplyOther",
  "realtime.reauthBody",
  "realtime.continue",
] as const;

describe("merged app catalogs", () => {
  test("includes keys supplied by shared packages", () => {
    const t = createServerT("es", { shipped: USER_CATALOGS });

    expect(t("common.siteName")).toBe("Bulletin");
    expect(t("user.placeholder.body")).toBe(USER_CATALOGS.es["user.placeholder.body"]);
  });
});

describe("notification catalogs", () => {
  test("ship the same keys in English, Spanish and French", () => {
    const english = Object.keys(USER_CATALOGS.en).sort();

    for (const locale of LOCALES) {
      expect(Object.keys(USER_CATALOGS[locale]).sort()).toEqual(english);
    }
  });

  test("translate every notification, preference and banner string", () => {
    for (const locale of LOCALES) {
      for (const key of REQUIRED_NOTIFICATION_KEYS) {
        expect(USER_CATALOGS[locale][key]?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});

const REQUIRED_REACTION_REPUTATION_KEYS = [
  "reaction.bar",
  "reaction.pick",
  "reaction.remove",
  "reaction.whoReacted",
  "reaction.close",
  "reaction.loading",
  "reaction.empty",
  "reaction.failed",
  "reaction.label.like",
  "reaction.label.thanks",
  "reaction.label.love",
  "reaction.label.laugh",
  "reaction.label.wow",
  "reaction.label.sad",
  "reaction.label.confused",
  "reaction.label.angry",
  "reputation.label.notorious",
  "reputation.label.disliked",
  "reputation.label.neutral",
  "reputation.label.respected",
  "reputation.label.revered",
  "reputation.giveUp",
  "reputation.giveDown",
  "reputation.givenUp",
  "reputation.givenDown",
  "reputation.failed",
  "reputation.dailyLimit",
  "reputation.minPosts",
  "reputation.negativeNotAllowed",
  "reputation.cannotReceive",
  "reputation.alreadyGiven",
  "reputation.ownPost",
] as const;

describe("reaction and reputation catalogs", () => {
  test("translate every reaction and reputation label and control string", () => {
    for (const locale of LOCALES) {
      for (const key of REQUIRED_REACTION_REPUTATION_KEYS) {
        expect(USER_CATALOGS[locale][key]?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});

const REQUIRED_API_KEY_KEYS = [
  "api.docs.title",
  "api.docs.intro",
  "api.docs.loading",
  "api.docs.error",
  "api.docs.raw",
  "apiKeys.title",
  "apiKeys.intro",
  "apiKeys.list.title",
  "apiKeys.loading",
  "apiKeys.empty",
  "apiKeys.loadError",
  "apiKeys.create.title",
  "apiKeys.label",
  "apiKeys.scopes",
  "apiKeys.create.submit",
  "apiKeys.secretOnce",
  "apiKeys.revoke",
  "apiKeys.revoked",
  "apiKeys.createFailed",
  "apiKeys.revokeFailed",
  "apiKeys.invalid",
  "apiKeys.scope.readForums",
  "apiKeys.scope.writePosts",
] as const;

describe("public API catalogs", () => {
  test("translate the API documentation and personal key screens", () => {
    for (const locale of LOCALES) {
      for (const key of REQUIRED_API_KEY_KEYS) {
        expect(USER_CATALOGS[locale][key]?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});
