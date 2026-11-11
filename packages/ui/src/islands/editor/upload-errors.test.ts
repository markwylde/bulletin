import { describe, expect, test } from "bun:test";
import { formatUploadBytes, uploadErrorMessage } from "./upload-errors.ts";

const labels = {
  uploadQuota: "No space.",
  uploadQuotaRemaining: "Only %remaining% left.",
  uploadTooLarge: "Too large.",
  uploadType: "Wrong type.",
  uploadRejected: "Rejected.",
  uploadFailed: "Failed.",
} as const;

describe("editor upload errors", () => {
  test("shows the remaining quota in the localised size", () => {
    expect(
      uploadErrorMessage(labels, { code: "quota_exceeded", remainingBytes: 2 * 1024 * 1024 }, "en"),
    ).toBe("Only 2 MB left.");
    expect(uploadErrorMessage(labels, { code: "quota_exceeded", remainingBytes: 2048 }, "en")).toBe(
      "Only 2 kB left.",
    );
    expect(uploadErrorMessage(labels, { code: "quota_exceeded" }, "en")).toBe("No space.");
  });

  test("maps the other upload codes and formats units", () => {
    expect(uploadErrorMessage(labels, { code: "file_too_large" }, "en")).toBe("Too large.");
    expect(uploadErrorMessage(labels, { code: "type_not_allowed" }, "en")).toBe("Wrong type.");
    expect(uploadErrorMessage(labels, { code: "attachment_rejected" }, "en")).toBe("Rejected.");
    expect(uploadErrorMessage(labels, { code: "other" }, "en")).toBe("Failed.");
    expect(formatUploadBytes(512, "en")).toBe("512 byte");
  });
});
