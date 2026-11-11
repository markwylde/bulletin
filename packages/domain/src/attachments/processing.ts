import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import {
  ATTACHMENT_IMAGE_MAX_EDGE,
  ATTACHMENT_MAX_PIXELS,
  ATTACHMENT_THUMBNAIL_MAX_EDGE,
  type AttachmentContentType,
  DOCUMENT_ATTACHMENT_TYPES,
  isAttachmentContentType,
  isRasterAttachmentType,
  isTextAttachmentType,
  isVerifiableText,
  SVG_ATTACHMENT_TYPE,
  sha256Hex,
} from "./rules.ts";

/** A rejection the pipeline understands; the message is a stable code, never user-facing. */
export class AttachmentProcessingError extends Error {
  readonly code: "type_not_allowed" | "image_invalid" | "image_too_large";

  constructor(code: "type_not_allowed" | "image_invalid" | "image_too_large") {
    super(code);
    this.name = "AttachmentProcessingError";
    this.code = code;
  }
}

export interface ProcessedAttachmentBytes {
  /** Re-encoded bytes to publish; absent means the verified snapshot is published unchanged. */
  readonly bytes?: Uint8Array;
  /** The type actually stored and served, never copied from the client declaration. */
  readonly contentType: AttachmentContentType;
  /** The type sniffed from the input, checked against the effective group/board allowlist. */
  readonly sourceType: AttachmentContentType;
  /** WebP preview for posts and the file list. */
  readonly thumbnail?: Uint8Array;
}

const RASTER_FORMATS = new Set(["jpeg", "png", "gif", "webp", "avif"]);
const DOCUMENT_TYPES = new Set<string>(DOCUMENT_ATTACHMENT_TYPES);

function sharpImage(bytes: Uint8Array): ReturnType<typeof sharp> {
  return sharp(bytes, { failOn: "error", limitInputPixels: ATTACHMENT_MAX_PIXELS, pages: 1 });
}

async function assertRaster(image: ReturnType<typeof sharp>): Promise<void> {
  const metadata = await image.metadata();

  if (metadata.format === undefined || !RASTER_FORMATS.has(metadata.format)) {
    throw new AttachmentProcessingError("image_invalid");
  }
}

/** Shared WebP re-encode: rotation, bounded dimensions and every metadata block dropped. */
async function encodeWebp(
  image: ReturnType<typeof sharp>,
  maxEdge: number,
  quality: number,
): Promise<Uint8Array> {
  const output = await image
    .clone()
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .webp({ quality, effort: 4 })
    .toBuffer();

  return new Uint8Array(output);
}

export interface ProcessedRasterImage {
  readonly bytes: Uint8Array;
  readonly contentType: "image/webp";
}

/**
 * Re-encodes one remote or uploaded raster image with the attachment pipeline. Unfurl proxies
 * reuse this so every image that reaches the files origin is decoded, stripped and bounded by
 * the same code (ADR 0019).
 */
export async function processRasterImage(
  bytes: Uint8Array,
  options: { readonly maxEdge?: number } = {},
): Promise<ProcessedRasterImage> {
  try {
    const image = sharpImage(bytes);
    await assertRaster(image);

    return {
      bytes: await encodeWebp(image, options.maxEdge ?? ATTACHMENT_IMAGE_MAX_EDGE, 82),
      contentType: "image/webp",
    };
  } catch (error) {
    if (error instanceof AttachmentProcessingError) {
      throw error;
    }

    throw new AttachmentProcessingError("image_invalid");
  }
}

/** Decodes and re-encodes a raster image to WebP, dropping every metadata block (ADR 0019). */
async function processRaster(
  bytes: Uint8Array,
  sourceType: AttachmentContentType,
): Promise<ProcessedAttachmentBytes> {
  try {
    const image = sharpImage(bytes);
    await assertRaster(image);

    const [main, thumbnail] = await Promise.all([
      encodeWebp(image, ATTACHMENT_IMAGE_MAX_EDGE, 82),
      encodeWebp(image, ATTACHMENT_THUMBNAIL_MAX_EDGE, 75),
    ]);

    return {
      bytes: main,
      contentType: "image/webp",
      sourceType,
      thumbnail,
    };
  } catch (error) {
    if (error instanceof AttachmentProcessingError) {
      throw error;
    }

    throw new AttachmentProcessingError("image_invalid");
  }
}

/**
 * SVG is never rendered inline (ADR 0019): the original stays download-only and this produces
 * only the rasterised preview the post displays.
 */
async function processSvg(bytes: Uint8Array): Promise<ProcessedAttachmentBytes> {
  try {
    const thumbnail = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: ATTACHMENT_MAX_PIXELS,
    })
      .resize({
        width: ATTACHMENT_THUMBNAIL_MAX_EDGE,
        height: ATTACHMENT_THUMBNAIL_MAX_EDGE,
        fit: "inside",
      })
      .webp({ quality: 80, effort: 4 })
      .toBuffer();

    return {
      contentType: SVG_ATTACHMENT_TYPE,
      sourceType: SVG_ATTACHMENT_TYPE,
      thumbnail: new Uint8Array(thumbnail),
    };
  } catch {
    throw new AttachmentProcessingError("type_not_allowed");
  }
}

/**
 * Verifies the bytes against the allowlist and produces everything the pipeline publishes.
 * The declared type is only a hint: magic bytes win when they identify a format, and text
 * formats have to decode as UTF-8. Every failure is a rejection, never an optimistic pass.
 */
export async function processAttachmentBytes(
  bytes: Uint8Array,
  declaredType: AttachmentContentType,
): Promise<ProcessedAttachmentBytes> {
  if (bytes.byteLength === 0) {
    throw new AttachmentProcessingError("type_not_allowed");
  }

  let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>;

  try {
    detected = await fileTypeFromBuffer(bytes);
  } catch {
    // Truncated or malformed files make the sniffer throw; treat that as unknown content.
    detected = undefined;
  }

  if (detected === undefined) {
    if (isRasterAttachmentType(declaredType)) {
      // An image must actually decode as one; a renamed non-image is rejected here.
      throw new AttachmentProcessingError("type_not_allowed");
    }

    if (declaredType === SVG_ATTACHMENT_TYPE) {
      return processSvg(bytes);
    }

    if (isTextAttachmentType(declaredType)) {
      if (!isVerifiableText(bytes)) {
        throw new AttachmentProcessingError("type_not_allowed");
      }

      return { contentType: declaredType, sourceType: declaredType };
    }

    throw new AttachmentProcessingError("type_not_allowed");
  }

  if (DOCUMENT_TYPES.has(detected.mime)) {
    return {
      contentType: detected.mime as AttachmentContentType,
      sourceType: detected.mime as AttachmentContentType,
    };
  }

  if (detected.mime === SVG_ATTACHMENT_TYPE) {
    return processSvg(bytes);
  }

  if (isTextAttachmentType(detected.mime)) {
    if (!isVerifiableText(bytes)) {
      throw new AttachmentProcessingError("type_not_allowed");
    }

    return { contentType: detected.mime, sourceType: detected.mime };
  }

  if (!isAttachmentContentType(detected.mime)) {
    throw new AttachmentProcessingError("type_not_allowed");
  }

  if (isRasterAttachmentType(detected.mime)) {
    return processRaster(bytes, detected.mime);
  }

  throw new AttachmentProcessingError("type_not_allowed");
}

export const AVATAR_SIZES = { lg: 512, md: 128, sm: 48 } as const;

export interface ProcessedAvatarImage {
  /** Content hash shared by every size; a new avatar gets a new URL (ADR 0019). */
  readonly hash: string;
  readonly sizes: Readonly<Record<keyof typeof AVATAR_SIZES, Uint8Array>>;
}

/**
 * Crops the uploaded image to a centred square and re-encodes it at three display sizes,
 * stripping every metadata block. Avatars are public, so the bytes are validated as a real
 * raster image before anything is stored.
 */
export async function processAvatarImage(
  bytes: Uint8Array,
  options: { readonly maxWidth?: number; readonly maxHeight?: number } = {},
): Promise<ProcessedAvatarImage> {
  try {
    const image = sharpImage(bytes);
    await assertRaster(image);
    const metadata = await image.metadata();
    const maxWidth = options.maxWidth ?? 512;
    const maxHeight = options.maxHeight ?? 512;

    if ((metadata.width ?? 0) > maxWidth || (metadata.height ?? 0) > maxHeight) {
      throw new AttachmentProcessingError("image_too_large");
    }

    const sizes = {} as Record<keyof typeof AVATAR_SIZES, Uint8Array>;

    for (const [variant, edge] of Object.entries(AVATAR_SIZES) as Array<
      [keyof typeof AVATAR_SIZES, number]
    >) {
      const output = await image
        .clone()
        .rotate()
        .resize({ width: edge, height: edge, fit: "cover", position: "centre" })
        .webp({ quality: 82, effort: 4 })
        .toBuffer();

      sizes[variant] = new Uint8Array(output);
    }

    return { hash: sha256Hex(sizes.lg), sizes };
  } catch (error) {
    if (error instanceof AttachmentProcessingError) {
      throw error;
    }

    throw new AttachmentProcessingError("image_invalid");
  }
}
