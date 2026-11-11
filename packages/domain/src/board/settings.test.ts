import { describe, expect, test } from "bun:test";
import { ATTACHMENT_CONTENT_TYPES } from "../attachments/rules.ts";
import {
  canonicalAttachmentTypes,
  DEFAULT_ATTACHMENT_TYPES,
  parseBoardSettingsInput,
} from "./settings.ts";

const VALID = {
  boardName: "Bulletin",
  boardDescription: "A board",
  defaultLocale: "en",
  offline: false,
  offlineMessage: "",
  topicsPerPage: 20,
  postsPerPage: 20,
  publicEditHistory: false,
} as const;

describe("board attachment settings", () => {
  test("defaults to every shipped content type when the field is omitted", () => {
    const parsed = parseBoardSettingsInput(VALID);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.attachmentAllowedTypes : null).toEqual(
      DEFAULT_ATTACHMENT_TYPES,
    );
  });

  test("keeps a valid subset in canonical order", () => {
    const parsed = parseBoardSettingsInput({
      ...VALID,
      attachmentAllowedTypes: ["application/pdf", "image/png", "image/png"],
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.attachmentAllowedTypes : null).toEqual([
      "image/png",
      "application/pdf",
    ]);
  });

  test("rejects unknown types and non-arrays", () => {
    expect(
      parseBoardSettingsInput({ ...VALID, attachmentAllowedTypes: ["application/exe"] }),
    ).toEqual({ ok: false, fields: ["attachmentAllowedTypes"] });
    expect(parseBoardSettingsInput({ ...VALID, attachmentAllowedTypes: "image/png" })).toEqual({
      ok: false,
      fields: ["attachmentAllowedTypes"],
    });
  });

  test("allows an empty allowlist and filters unknown canonical entries", () => {
    expect(parseBoardSettingsInput({ ...VALID, attachmentAllowedTypes: [] }).ok).toBe(true);
    expect(canonicalAttachmentTypes(["image/webp", "nope", "image/webp"])).toEqual(["image/webp"]);
    expect(canonicalAttachmentTypes(ATTACHMENT_CONTENT_TYPES)).toHaveLength(
      ATTACHMENT_CONTENT_TYPES.length,
    );
  });
});
