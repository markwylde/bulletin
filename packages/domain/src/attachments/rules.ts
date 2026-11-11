/**
 * The shipped attachment allowlist and upload-input rules (ADR 0019). The per-group and
 * board settings that make this configurable arrive with the settings change; until then the
 * pipeline fails closed for anything outside this set.
 */

/** Raster images are the only attachments that may ever be rendered inline. */
export const RASTER_ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
] as const;

/** SVG is accepted but only ever rasterised for display and offered as a download. */
export const SVG_ATTACHMENT_TYPE = "image/svg+xml";

/** Text formats have no magic bytes; their bytes must decode as UTF-8 without NULs. */
export const TEXT_ATTACHMENT_TYPES = ["text/plain", "text/html", "text/csv"] as const;

/** Documents are published unchanged, always as a download. */
export const DOCUMENT_ATTACHMENT_TYPES = ["application/pdf", "application/zip"] as const;

export const ATTACHMENT_CONTENT_TYPES = [
  ...RASTER_ATTACHMENT_TYPES,
  SVG_ATTACHMENT_TYPE,
  ...TEXT_ATTACHMENT_TYPES,
  ...DOCUMENT_ATTACHMENT_TYPES,
] as const;

export type AttachmentContentType = (typeof ATTACHMENT_CONTENT_TYPES)[number];
export type RasterAttachmentType = (typeof RASTER_ATTACHMENT_TYPES)[number];
export type TextAttachmentType = (typeof TEXT_ATTACHMENT_TYPES)[number];

export const ATTACHMENT_MAX_FILENAME_LENGTH = 255;
/** Sharp refuses larger decodes, bounding worker memory for a hostile image (ADR 0019). */
export const ATTACHMENT_MAX_PIXELS = 40_000_000;
export const ATTACHMENT_THUMBNAIL_MAX_EDGE = 480;
export const ATTACHMENT_IMAGE_MAX_EDGE = 2_400;

export function isAttachmentContentType(value: string): value is AttachmentContentType {
  return (ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(value);
}

export function isRasterAttachmentType(value: string): value is RasterAttachmentType {
  return (RASTER_ATTACHMENT_TYPES as readonly string[]).includes(value);
}

export function isTextAttachmentType(value: string): value is TextAttachmentType {
  return (TEXT_ATTACHMENT_TYPES as readonly string[]).includes(value);
}

/**
 * Filenames are display metadata only, never keys: take the basename, drop control characters
 * and quotes (safe for `Content-Disposition`) and keep the length bounded.
 */
export function normaliseFilename(raw: string): string | null {
  const base = raw.split(/[\\/]/).at(-1) ?? "";
  const cleaned = [...base]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f && character !== '"';
    })
    .join("")
    .trim()
    .slice(0, ATTACHMENT_MAX_FILENAME_LENGTH);

  return cleaned.length === 0 ? null : cleaned;
}

export interface UploadRequestInput {
  readonly forumId: string;
  readonly filename: string;
  readonly contentType: AttachmentContentType;
  readonly sizeBytes: number;
}

export type UploadRequestParseResult =
  | { readonly ok: true; readonly value: UploadRequestInput }
  | { readonly ok: false; readonly code: "invalid_request" | "type_not_allowed" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the upload request body before any quota row is touched. */
export function parseUploadRequest(value: unknown): UploadRequestParseResult {
  if (!isRecord(value)) {
    return { ok: false, code: "invalid_request" };
  }

  const forumId = value.forumId;
  const filename = typeof value.filename === "string" ? normaliseFilename(value.filename) : null;
  const contentType = value.contentType;
  const sizeBytes = value.sizeBytes;

  if (
    typeof forumId !== "string" ||
    !/^\d+$/.test(forumId) ||
    filename === null ||
    typeof contentType !== "string" ||
    typeof sizeBytes !== "number" ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0
  ) {
    return { ok: false, code: "invalid_request" };
  }

  if (!isAttachmentContentType(contentType)) {
    return { ok: false, code: "type_not_allowed" };
  }

  return {
    ok: true,
    value: { forumId, filename, contentType, sizeBytes },
  };
}

/** UTF-8 text without NULs; the only content check possible for text formats. */
export function isVerifiableText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) {
    return false;
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Content address for the snapshot/checksum comparisons in the upload state machine. */
export function sha256Hex(bytes: Uint8Array): string {
  return Bun.CryptoHasher.hash("sha256", bytes).toString("hex");
}

/** Optional virus-scan stage; the default is a no-op (ADR 0019). */
export interface AttachmentScanInput {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export type AttachmentScan = (
  input: AttachmentScanInput,
) => "clean" | "infected" | Promise<"clean" | "infected">;
