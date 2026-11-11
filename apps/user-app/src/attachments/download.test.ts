import { describe, expect, test } from "bun:test";
import { contentDisposition } from "./download.ts";

describe("attachment content disposition", () => {
  test("keeps raster images inline and forces other files to download", () => {
    expect(contentDisposition("inline", "photo.jpg")).toBe(
      "inline; filename=\"photo.jpg\"; filename*=UTF-8''photo.jpg",
    );
    expect(contentDisposition("attachment", "notes.html")).toContain("attachment; filename=");
  });

  test("uses an ASCII fallback plus an RFC 5987 UTF-8 filename", () => {
    const value = contentDisposition("attachment", 'naïve "report".pdf');

    expect(value).toContain('filename="na_ve _report_.pdf"');
    expect(value).toContain("filename*=UTF-8''na%C3%AFve%20%22report%22.pdf");
  });
});
