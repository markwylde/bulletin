import { describe, expect, test } from "bun:test";
import { LOCALES } from "@bulletin/i18n";
import { loadDefaultThemeTemplates } from "@bulletin/templates";
import { STAFF_CATALOGS } from "../../apps/staff-app/src/catalogs.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";

function referencedKeys(source: string): readonly string[] {
  const keys = new Set<string>();

  for (const match of source.matchAll(/{%\s*t\s+"([^"]+)"/g)) {
    if (match[1] !== undefined) {
      keys.add(match[1]);
    }
  }

  for (const match of source.matchAll(/\bt\("([^"]+)"\)/g)) {
    if (match[1] !== undefined) {
      keys.add(match[1]);
    }
  }

  for (const match of source.matchAll(/messageKey:\s*"([^"]+)"/g)) {
    if (match[1] !== undefined) {
      keys.add(match[1]);
    }
  }

  return [...keys];
}

describe("forum-structure strings", () => {
  test("every template key exists in en, es and fr", async () => {
    const templates = await loadDefaultThemeTemplates();
    const missing: string[] = [];

    for (const [name, body] of Object.entries(templates)) {
      for (const key of referencedKeys(body)) {
        for (const locale of LOCALES) {
          if (USER_CATALOGS[locale][key] === undefined) {
            missing.push(`${name}: ${locale} ${key}`);
          }
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test("every staff screen string exists in en, es and fr", async () => {
    const missing: string[] = [];

    for await (const path of new Bun.Glob("apps/staff-app/src/**/*.{ts,tsx}").scan({
      cwd: new URL("../../", import.meta.url).pathname,
      onlyFiles: true,
    })) {
      if (path.includes(".test.")) {
        continue;
      }

      const source = await Bun.file(`${new URL("../../", import.meta.url).pathname}${path}`).text();

      for (const key of referencedKeys(source)) {
        for (const locale of LOCALES) {
          if (STAFF_CATALOGS[locale][key] === undefined) {
            missing.push(`${path}: ${locale} ${key}`);
          }
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test("the topic, posting, poll, history and unread keys are present", () => {
    const keys = [
      "index.topicReplies",
      "index.topicViews",
      "topic.pinned",
      "topic.locked",
      "topic.moved",
      "topic.pagination",
      "topic.previousPage",
      "topic.nextPage",
      "topic.pageOf",
      "topic.backToForum",
      "topic.modNote",
      "topic.views",
      "topic.firstUnread",
      "topic.new",
      "topic.title",
      "topic.prefix",
      "topic.choosePrefix",
      "topic.create",
      "topic.postFailed",
      "topic.delete",
      "topic.confirmDelete",
      "post.quote",
      "post.history",
      "post.delete",
      "post.restore",
      "post.hardDelete",
      "post.confirmDelete",
      "post.confirmHardDelete",
      "post.edit",
      "post.body",
      "post.redact",
      "post.save",
      "post.editFailed",
      "post.reply",
      "post.submitReply",
      "post.permalink",
      "post.deleted",
      "post.unapproved",
      "post.editedByAt",
      "poll.title",
      "poll.vote",
      "poll.voteFailed",
      "poll.results",
      "poll.voters",
      "poll.add",
      "poll.question",
      "poll.choice",
      "poll.multiple",
      "poll.addChoice",
      "poll.remove",
      "poll.addQuestion",
      "poll.closesAt",
      "poll.resultsVisible",
      "read.markForum",
      "read.markBoard",
      "member.postCount",
      "member.deletedName",
      "member.noGroup",
    ] as const;
    const missing: string[] = [];

    for (const key of keys) {
      for (const locale of LOCALES) {
        if (USER_CATALOGS[locale][key] === undefined) {
          missing.push(`${locale} ${key}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test("the index, forum, prefix and announcement keys are present", () => {
    const userKeys = [
      "index.topicCount",
      "index.postCount",
      "index.lastPost",
      "index.lastPostBy",
      "index.redirectClicks",
      "index.subforums",
      "forum.rules.title",
      "forum.prefixFilter",
      "forum.prefixAll",
      "forum.announcements",
      "forum.moderators",
      "forum.locked.title",
      "forum.locked.body",
      "forum.locked.password",
      "forum.locked.submit",
      "forum.locked.wrong",
      "forum.modNote",
      "announcement.dismiss",
    ] as const;
    const staffKeys = [
      "staff.nav.forums",
      "staff.nav.prefixes",
      "staff.nav.announcements",
      "staff.groups.permission.acpForums",
      "staff.groups.permission.acpAnnouncements",
      "staff.forums.title",
      "staff.forums.tree.title",
      "staff.forums.settings.title",
      "staff.prefixes.title",
      "staff.prefixes.label.en",
      "staff.prefixes.label.es",
      "staff.prefixes.label.fr",
      "staff.announcements.title",
      "staff.announcements.field.startsAt",
      "staff.announcements.field.groups",
    ] as const;

    for (const locale of LOCALES) {
      for (const key of userKeys) {
        expect(USER_CATALOGS[locale][key]?.trim().length).toBeGreaterThan(0);
      }

      for (const key of staffKeys) {
        expect(STAFF_CATALOGS[locale][key]?.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
