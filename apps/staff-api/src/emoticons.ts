import {
  deleteEmoticon,
  deleteEmoticonSet,
  EMOTICON_CONTENT_TYPES,
  type EmoticonContentType,
  type EmoticonMutation,
  listEmoticonSets,
  readEmoticonImage,
  saveEmoticon,
  saveEmoticonSet,
} from "@bulletin/domain/content";
import { emoticonMutation, runMutation } from "@bulletin/domain/mutations";
import { opaqueKey, type StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";
import sharp from "sharp";
import { writeAdminLog } from "./admin-log.ts";

const MAX_IMAGE_BYTES = 256 * 1024;
const MAX_IMAGE_DIMENSION = 256;
const MAX_INPUT_PIXELS = 4096 * 4096;
const INPUT_FORMATS = new Set(["png", "jpeg", "gif", "webp"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentType(value: unknown): EmoticonContentType | null {
  return typeof value === "string" && (EMOTICON_CONTENT_TYPES as readonly string[]).includes(value)
    ? (value as EmoticonContentType)
    : null;
}

export interface ProcessedEmoticonImage {
  readonly bytes: Uint8Array;
  readonly contentType: "image/png";
}

/**
 * Decodes and re-encodes every upload as a PNG. Re-encoding drops EXIF (including GPS
 * location) and every other metadata block, and only formats we can actually decode are
 * accepted, so the declared content type is never trusted (ADR 0012).
 */
export async function processEmoticonImage(bytes: Uint8Array): Promise<ProcessedEmoticonImage> {
  const image = sharp(bytes, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, pages: 1 });
  const { format, width, height } = await image.metadata();

  if (format === undefined || !INPUT_FORMATS.has(format) || width === 0 || height === 0) {
    throw new Error(`Unsupported emoticon image: ${format ?? "unknown"}`);
  }

  const output = await image
    .rotate()
    .resize({
      width: MAX_IMAGE_DIMENSION,
      height: MAX_IMAGE_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });

  return { bytes: new Uint8Array(output.data), contentType: "image/png" };
}

function imageBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  try {
    const bytes = Buffer.from(value, "base64");

    return bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES
      ? null
      : new Uint8Array(bytes);
  } catch {
    return null;
  }
}

export async function listEmoticonsForStaff(sql: SQL) {
  const sets = await listEmoticonSets(sql);

  return {
    sets: sets.map((set) => ({
      ...set,
      emoticons: set.emoticons.map((emoticon) => ({
        ...emoticon,
        src: `/api/staff/emoticons/image?id=${emoticon.id}`,
      })),
    })),
  };
}

export async function emoticonImageForStaff(
  sql: SQL,
  storage: StorageClient,
  id: string,
): Promise<Response> {
  const image = await readEmoticonImage(sql, id);

  if (image === null) {
    return Response.json({ code: "not_found" }, { status: 404 });
  }

  try {
    return new Response(await storage.get(image.storageKey), {
      headers: {
        "content-type": image.contentType,
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return Response.json({ code: "not_found" }, { status: 404 });
  }
}

/** Runs one emoticon write and its cache-tag bump in a single transaction (ADR 0006). */
function mutateWithTag(
  sql: SQL,
  action: string,
  apply: (tx: SQL) => Promise<EmoticonMutation>,
): Promise<EmoticonMutation> {
  return runMutation({
    sql,
    mutation: emoticonMutation,
    input: { action },
    apply,
  });
}

function log(
  sql: SQL,
  actorMemberId: string,
  action: string,
  targetId: string,
  summary: Record<string, unknown>,
): Promise<void> {
  return writeAdminLog(sql, {
    actorMemberId,
    action,
    targetType: "emoticon",
    targetId,
    summary,
  });
}

/** Applies one admin action; an uploaded image is deleted when the row cannot be saved. */
export async function mutateEmoticon(
  sql: SQL,
  storage: StorageClient,
  actorMemberId: string,
  body: unknown,
): Promise<EmoticonMutation & { readonly code?: string }> {
  if (!isRecord(body) || typeof body.action !== "string") {
    return { ok: false, code: "invalid" };
  }

  switch (body.action) {
    case "set-save": {
      const result = await mutateWithTag(sql, "set-save", (tx) => saveEmoticonSet(tx, body.set));

      if (result.ok && result.id !== undefined) {
        await log(sql, actorMemberId, "emoticon.set.save", result.id, {
          set: body.set,
        });
      }

      return result;
    }
    case "set-delete": {
      const id = typeof body.id === "string" ? body.id : "";
      const result = await mutateWithTag(sql, "set-delete", (tx) => deleteEmoticonSet(tx, id));

      if (result.ok) {
        await log(sql, actorMemberId, "emoticon.set.delete", id, { id });
      }

      return result;
    }
    case "emoticon-delete": {
      const id = typeof body.id === "string" ? body.id : "";
      const result = await mutateWithTag(sql, "emoticon-delete", (tx) => deleteEmoticon(tx, id));

      if (result.ok) {
        await log(sql, actorMemberId, "emoticon.delete", id, { id });
      }

      return result;
    }
    case "emoticon-save": {
      const setId = typeof body.setId === "string" ? body.setId : "";
      const code = typeof body.code === "string" ? body.code.trim().toLowerCase() : "";
      const alt = typeof body.alt === "string" ? body.alt.trim() : "";
      const type = contentType(body.contentType);
      const bytes = imageBytes(body.imageBase64);
      const position =
        typeof body.position === "number" && Number.isInteger(body.position) && body.position >= 0
          ? body.position
          : 0;
      const id = typeof body.id === "string" ? body.id : undefined;
      let key: string;
      let finalType: EmoticonContentType;

      if (type !== null && bytes !== null) {
        key = opaqueKey("emoticon");

        try {
          const processed = await processEmoticonImage(bytes);
          finalType = processed.contentType;
          await storage.put(key, processed.bytes, { contentType: processed.contentType });
        } catch {
          return { ok: false, code: "invalid", fields: ["image"] };
        }
      } else if (id !== undefined) {
        const existing = await readEmoticonImage(sql, id);

        if (existing === null) {
          return { ok: false, code: "not_found", fields: ["id"] };
        }

        key = existing.storageKey;
        finalType = existing.contentType;
      } else {
        return { ok: false, code: "invalid", fields: ["image"] };
      }

      const result = await mutateWithTag(sql, "emoticon-save", (tx) =>
        saveEmoticon(tx, {
          ...(id === undefined ? {} : { id }),
          setId,
          code,
          alt,
          storageKey: key,
          contentType: finalType,
          position,
        }),
      );

      if (!result.ok) {
        if (type !== null && bytes !== null) {
          await storage.delete(key).catch(() => undefined);
        }

        return result;
      }

      await log(sql, actorMemberId, "emoticon.save", result.id ?? "", {
        setId,
        code,
        alt,
        contentType: finalType,
        position,
      });

      return result;
    }
    default:
      return { ok: false, code: "invalid" };
  }
}
