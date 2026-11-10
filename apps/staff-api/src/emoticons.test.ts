import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { processEmoticonImage } from "./emoticons.ts";

const LOCATION = "GPS -33.8688,151.2093";

async function jpegWithExif(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 32, channels: 3, background: { r: 0, g: 128, b: 255 } },
  })
    .jpeg()
    .withExif({ IFD0: { ImageDescription: LOCATION, Software: "Camera" } })
    .toBuffer();
}

describe("emoticon image processing (ADR 0012)", () => {
  test("re-encodes uploads as PNG and removes EXIF metadata", async () => {
    const original = await jpegWithExif();

    // The fixture really does carry the metadata the reviewer found in public downloads.
    expect((await sharp(original).metadata()).exif).toBeDefined();
    expect(original.includes(LOCATION)).toBe(true);

    const processed = await processEmoticonImage(new Uint8Array(original));
    const stored = Buffer.from(processed.bytes);
    const metadata = await sharp(stored).metadata();

    expect(processed.contentType).toBe("image/png");
    expect(metadata.format).toBe("png");
    expect(metadata.exif).toBeUndefined();
    expect(stored.includes(LOCATION)).toBe(false);
    expect(metadata.width).toBeLessThanOrEqual(256);
    expect(metadata.height).toBeLessThanOrEqual(256);
  });

  test("applies the EXIF orientation before dropping it", async () => {
    const original = await sharp({
      create: { width: 40, height: 20, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const processed = await processEmoticonImage(new Uint8Array(original));
    const metadata = await sharp(Buffer.from(processed.bytes)).metadata();

    expect(metadata.exif).toBeUndefined();
    expect(metadata.width).toBe(20);
    expect(metadata.height).toBe(40);
  });

  test("rejects bytes that are not a supported image", async () => {
    await expect(processEmoticonImage(new TextEncoder().encode("not an image"))).rejects.toThrow();
  });

  test("rejects formats outside the emoticon allowlist", async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>',
    );

    await expect(processEmoticonImage(svg)).rejects.toThrow();
  });
});
