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
} from "./rules.ts";

/** A rejection the pipeline understands; the message is a stable code, never user-facing. */
export class AttachmentProcessingError extends Error {
  readonly code: "type_not_allowed" | "image_invalid";

  constructor(code: "type_not_allowed" | "image_invalid") {
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
  /** WebP preview for posts and the file list. */
  readonly thumbnail?: Uint8Array;
}

const RASTER_FORMATS = new Set(["jpeg", "png", "gif", "webp", "avif"]);
const DOCUMENT_TYPES = new Set<string>(DOCUMENT_ATTACHMENT_TYPES);

function sharpImage(bytes: Uint8Array): ReturnType<typeof sharp> {
  return sharp(bytes, { failOn: "error", limitInputPixels: ATTACHMENT_MAX_PIXELS, pages: 1 });
}

/** Decodes and re-encodes a raster image to WebP, dropping every metadata block (ADR 0019). */
async function processRaster(bytes: Uint8Array): Promise<ProcessedAttachmentBytes> {
  try {
    const image = sharpImage(bytes);
    const metadata = await image.metadata();

    if (metadata.format === undefined || !RASTER_FORMATS.has(metadata.format)) {
      throw new AttachmentProcessingError("image_invalid");
    }

    const [main, thumbnail] = await Promise.all([
      image
        .clone()
        .rotate()
        .resize({
          width: ATTACHMENT_IMAGE_MAX_EDGE,
          height: ATTACHMENT_IMAGE_MAX_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 82, effort: 4 })
        .toBuffer(),
      image
        .clone()
        .rotate()
        .resize({
          width: ATTACHMENT_THUMBNAIL_MAX_EDGE,
          height: ATTACHMENT_THUMBNAIL_MAX_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 75, effort: 4 })
        .toBuffer(),
    ]);

    return {
      bytes: new Uint8Array(main),
      contentType: "image/webp",
      thumbnail: new Uint8Array(thumbnail),
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

    return { contentType: SVG_ATTACHMENT_TYPE, thumbnail: new Uint8Array(thumbnail) };
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

      return { contentType: declaredType };
    }

    throw new AttachmentProcessingError("type_not_allowed");
  }

  if (DOCUMENT_TYPES.has(detected.mime)) {
    return { contentType: detected.mime as AttachmentContentType };
  }

  if (detected.mime === SVG_ATTACHMENT_TYPE) {
    return processSvg(bytes);
  }

  if (isTextAttachmentType(detected.mime)) {
    if (!isVerifiableText(bytes)) {
      throw new AttachmentProcessingError("type_not_allowed");
    }

    return { contentType: detected.mime };
  }

  if (!isAttachmentContentType(detected.mime)) {
    throw new AttachmentProcessingError("type_not_allowed");
  }

  if (isRasterAttachmentType(detected.mime)) {
    return processRaster(bytes);
  }

  throw new AttachmentProcessingError("type_not_allowed");
}
