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

describe("board API rate settings", () => {
  test("defaults to 60 per key and 120 per IP when omitted", () => {
    const parsed = parseBoardSettingsInput(VALID);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.apiKeyRateLimitPerMinute : null).toBe(60);
    expect(parsed.ok ? parsed.value.apiIpRateLimitPerMinute : null).toBe(120);
  });

  test("keeps valid limits and rejects out-of-range values", () => {
    const parsed = parseBoardSettingsInput({
      ...VALID,
      apiKeyRateLimitPerMinute: 5,
      apiIpRateLimitPerMinute: 250,
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.apiKeyRateLimitPerMinute : null).toBe(5);
    expect(parsed.ok ? parsed.value.apiIpRateLimitPerMinute : null).toBe(250);

    expect(parseBoardSettingsInput({ ...VALID, apiKeyRateLimitPerMinute: 0 })).toEqual({
      ok: false,
      fields: ["apiKeyRateLimitPerMinute"],
    });
    expect(parseBoardSettingsInput({ ...VALID, apiIpRateLimitPerMinute: 10_001 })).toEqual({
      ok: false,
      fields: ["apiIpRateLimitPerMinute"],
    });
  });
});

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

describe("board robots.txt setting", () => {
  test("defaults to empty and normalises CRLF line endings", () => {
    expect(parseBoardSettingsInput(VALID)).toMatchObject({
      ok: true,
      value: { robotsTxt: "" },
    });
    expect(
      parseBoardSettingsInput({
        ...VALID,
        robotsTxt: "User-agent: *\r\nDisallow: /search\r\n",
      }),
    ).toMatchObject({
      ok: true,
      value: { robotsTxt: "User-agent: *\nDisallow: /search\n" },
    });
  });

  test("rejects a file over the storage limit", () => {
    expect(parseBoardSettingsInput({ ...VALID, robotsTxt: "x".repeat(65_536) })).toEqual({
      ok: false,
      fields: ["robotsTxt"],
    });
  });
});
