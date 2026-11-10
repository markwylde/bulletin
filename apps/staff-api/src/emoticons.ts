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
import { opaqueKey, type StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";

const MAX_IMAGE_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentType(value: unknown): EmoticonContentType | null {
  return typeof value === "string" && (EMOTICON_CONTENT_TYPES as readonly string[]).includes(value)
    ? (value as EmoticonContentType)
    : null;
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
      const result = await saveEmoticonSet(sql, body.set);

      if (result.ok && result.id !== undefined) {
        await log(sql, actorMemberId, "emoticon.set.save", result.id, {
          set: body.set,
        });
      }

      return result;
    }
    case "set-delete": {
      const id = typeof body.id === "string" ? body.id : "";
      const result = await deleteEmoticonSet(sql, id);

      if (result.ok) {
        await log(sql, actorMemberId, "emoticon.set.delete", id, { id });
      }

      return result;
    }
    case "emoticon-delete": {
      const id = typeof body.id === "string" ? body.id : "";
      const result = await deleteEmoticon(sql, id);

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
        finalType = type;

        try {
          await storage.put(key, bytes, { contentType: type });
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

      const result = await saveEmoticon(sql, {
        ...(id === undefined ? {} : { id }),
        setId,
        code,
        alt,
        storageKey: key,
        contentType: finalType,
        position,
      });

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
