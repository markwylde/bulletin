import { describe, expect, test } from "bun:test";
import { LOCALES } from "@bulletin/i18n";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";

const ATTACHMENT_AVATAR_KEYS = [
  "editor.attach",
  "editor.attachHint",
  "editor.upload.uploading",
  "editor.upload.processing",
  "editor.upload.ready",
  "editor.upload.failed",
  "editor.upload.quota",
  "editor.upload.tooLarge",
  "editor.upload.type",
  "editor.upload.rejected",
  "attachment.downloads",
  "attachment.remove",
  "attachment.removed",
  "account.attachments.body",
  "account.attachments.delete",
  "account.attachments.deleteFailed",
  "account.attachments.open",
  "account.attachments.title",
  "account.attachments.usage",
  "account.avatar.body",
  "account.avatar.title",
  "account.avatar.zoom",
  "account.avatar.save",
  "account.avatar.remove",
  "account.avatar.invalid",
  "account.avatar.tooLarge",
  "account.avatar.blocked",
  "account.avatar.notAllowed",
  "account.avatar.failed",
] as const;

describe("attachment and avatar strings", () => {
  test("every upload, error, list and avatar key exists in en, es and fr", () => {
    const missing: string[] = [];

    for (const locale of LOCALES) {
      for (const key of ATTACHMENT_AVATAR_KEYS) {
        const value = USER_CATALOGS[locale][key];

        if (typeof value !== "string" || value.trim() === "") {
          missing.push(`${locale} ${key}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
