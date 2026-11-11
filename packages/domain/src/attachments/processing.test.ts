import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
  AttachmentProcessingError,
  processAttachmentBytes,
  processAvatarImage,
} from "./processing.ts";

async function jpegWithExif(): Promise<Uint8Array> {
  const bytes = await sharp({
    create: { width: 48, height: 32, channels: 3, background: "#cc3300" },
  })
    .jpeg({ quality: 90 })
    .withExif({
      IFD0: { Copyright: "Bulletin" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" },
    })
    .toBuffer();

  return new Uint8Array(bytes);
}

function svgBytes(): Uint8Array {
  return new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64">' +
      '<rect width="96" height="64" fill="#2f855a"/></svg>',
  );
}

function executableBytes(): Uint8Array {
  const bytes = new Uint8Array(0x80);
  bytes.set([0x4d, 0x5a]); // "MZ"
  new DataView(bytes.buffer).setUint32(0x3c, 0x40, true);
  bytes.set([0x50, 0x45, 0, 0], 0x40); // "PE\0\0"
  return bytes;
}

describe("attachment content processing", () => {
  test("re-encodes raster images and strips EXIF including GPS", async () => {
    const original = await jpegWithExif();
    const before = await sharp(original).metadata();
    expect(before.exif).toBeDefined();

    const processed = await processAttachmentBytes(original, "image/jpeg");

    expect(processed.contentType).toBe("image/webp");
    expect(processed.bytes).toBeDefined();
    expect(processed.thumbnail).toBeDefined();

    const stored = await sharp(processed.bytes ?? new Uint8Array()).metadata();
    expect(stored.format).toBe("webp");
    expect(stored.exif).toBeUndefined();
    expect(stored.icc).toBeUndefined();
    expect(stored.xmp).toBeUndefined();

    const thumbnail = await sharp(processed.thumbnail ?? new Uint8Array()).metadata();
    expect(thumbnail.format).toBe("webp");
    expect(thumbnail.width).toBeLessThanOrEqual(480);
  });

  test("uses the detected type rather than the declared one", async () => {
    const png = new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } })
        .png()
        .toBuffer(),
    );

    const processed = await processAttachmentBytes(png, "image/jpeg");
    expect(processed.contentType).toBe("image/webp");
  });

  test("rejects an executable renamed to an image", async () => {
    await expect(processAttachmentBytes(executableBytes(), "image/jpeg")).rejects.toThrow(
      AttachmentProcessingError,
    );
  });

  test("rasterises SVG for display and publishes the original", async () => {
    const processed = await processAttachmentBytes(svgBytes(), "image/svg+xml");

    expect(processed.contentType).toBe("image/svg+xml");
    expect(processed.bytes).toBeUndefined();
    expect(processed.thumbnail).toBeDefined();

    const thumbnail = await sharp(processed.thumbnail ?? new Uint8Array()).metadata();
    expect(thumbnail.format).toBe("webp");
  });

  test("publishes documents unchanged", async () => {
    const pdf = new TextEncoder().encode(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n",
    );
    const processed = await processAttachmentBytes(pdf, "application/pdf");

    expect(processed.contentType).toBe("application/pdf");
    expect(processed.bytes).toBeUndefined();
    expect(processed.thumbnail).toBeUndefined();
  });

  test("accepts valid text and rejects binary bytes declared as text", async () => {
    const text = new TextEncoder().encode("Plain text, no markup.");

    expect(await processAttachmentBytes(text, "text/plain")).toEqual({
      contentType: "text/plain",
    });

    const binary = new Uint8Array([0x68, 0x69, 0x00, 0xff, 0xfe]);
    await expect(processAttachmentBytes(binary, "text/plain")).rejects.toThrow(
      AttachmentProcessingError,
    );
  });

  test("rejects a corrupt image with a plausible header", async () => {
    const truncated = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

    await expect(processAttachmentBytes(truncated, "image/jpeg")).rejects.toThrow(
      AttachmentProcessingError,
    );
  });
});

describe("avatar image processing", () => {
  test("crops a square and produces the three WebP sizes without metadata", async () => {
    const original = new Uint8Array(
      await sharp({ create: { width: 800, height: 600, channels: 3, background: "#336699" } })
        .jpeg()
        .withExif({ IFD0: { Copyright: "Bulletin" } })
        .toBuffer(),
    );

    const processed = await processAvatarImage(original);

    expect(processed.hash).toMatch(/^[0-9a-f]{64}$/);

    for (const [variant, edge] of [
      ["lg", 512],
      ["md", 128],
      ["sm", 48],
    ] as const) {
      const metadata = await sharp(processed.sizes[variant]).metadata();
      expect({
        variant,
        format: metadata.format,
        width: metadata.width,
        height: metadata.height,
      }).toEqual({
        variant,
        format: "webp",
        width: edge,
        height: edge,
      });
      expect(metadata.exif).toBeUndefined();
    }
  });

  test("rejects a non-image upload", async () => {
    await expect(processAvatarImage(new Uint8Array([0x4d, 0x5a, 0, 0]))).rejects.toThrow(
      AttachmentProcessingError,
    );
  });
});
