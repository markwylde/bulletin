import { describe, expect, test } from "bun:test";
import { isVerifiableText, normaliseFilename, parseUploadRequest } from "./rules.ts";

const VALID = {
  forumId: "12",
  filename: "Annual report.pdf",
  contentType: "application/pdf",
  sizeBytes: 2048,
} as const;

describe("upload request rules", () => {
  test("accepts a well-formed request", () => {
    expect(parseUploadRequest(VALID)).toEqual({ ok: true, value: VALID });
  });

  test("accepts one conversation context and rejects missing or doubled contexts", () => {
    const conversation = {
      conversationId: "9",
      filename: "notes.txt",
      contentType: "text/plain",
      sizeBytes: 10,
    } as const;

    expect(parseUploadRequest(conversation)).toEqual({ ok: true, value: conversation });
    expect(parseUploadRequest({ ...conversation, forumId: "12" })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(parseUploadRequest({ ...conversation, conversationId: undefined })).toEqual({
      ok: false,
      code: "invalid_request",
    });
  });

  test("rejects disallowed types before any quota work", () => {
    expect(parseUploadRequest({ ...VALID, contentType: "application/x-msdownload" })).toEqual({
      ok: false,
      code: "type_not_allowed",
    });
  });

  test("rejects malformed bodies and sizes", () => {
    expect(parseUploadRequest(null)).toEqual({ ok: false, code: "invalid_request" });
    expect(parseUploadRequest({ ...VALID, forumId: "abc" })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(parseUploadRequest({ ...VALID, sizeBytes: 0 })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(parseUploadRequest({ ...VALID, sizeBytes: 1.5 })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(parseUploadRequest({ ...VALID, filename: "   " })).toEqual({
      ok: false,
      code: "invalid_request",
    });
  });

  test("reduces a filename to a safe basename", () => {
    expect(normaliseFilename("../../etc/passwd")).toBe("passwd");
    expect(normaliseFilename("C:\\temp\\photo.jpg")).toBe("photo.jpg");
    expect(normaliseFilename('bad"name\r\n.txt')).toBe("badname.txt");
    expect(normaliseFilename("🎉 party.png")).toBe("🎉 party.png");
    expect(normaliseFilename("x".repeat(400))).toHaveLength(255);
  });

  test("validates text bytes without NULs", () => {
    expect(isVerifiableText(new TextEncoder().encode("hello"))).toBe(true);
    expect(isVerifiableText(new Uint8Array([0x68, 0x00, 0x69]))).toBe(false);
    expect(isVerifiableText(new Uint8Array([0xff, 0xfe]))).toBe(false);
  });
});
