import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { sanitizeThemeAsset } from "./assets.ts";

describe("theme asset sanitising", () => {
  test("re-encodes images and strips EXIF metadata", async () => {
    const source = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#cc3344" },
    })
      .jpeg()
      .withExif({ IFD0: { Copyright: "private location", Artist: "tester" } })
      .toBuffer();

    expect((await sharp(source).metadata()).exif).toBeDefined();

    const sanitised = await sanitizeThemeAsset(new Uint8Array(source), "image/jpeg");
    const metadata = await sharp(sanitised.bytes).metadata();

    expect(sanitised.contentType).toBe("image/jpeg");
    expect(metadata.exif).toBeUndefined();
    expect(metadata.width).toBe(8);
    expect(metadata.height).toBe(8);
  });

  test("keeps fonts untouched", async () => {
    const font = new Uint8Array([0, 1, 2, 3]);
    const sanitised = await sanitizeThemeAsset(font, "font/woff2");

    expect(sanitised.bytes).toEqual(font);
    expect(sanitised.contentType).toBe("font/woff2");
  });
});
