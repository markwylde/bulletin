import { listEditorEmoticons, readEmoticonImage } from "@bulletin/domain/content";
import type { StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";

const PUBLIC_CACHE = "public, s-maxage=60, stale-while-revalidate=60";
// A staff replacement changes the storage key, so the ETag changes with the image (ADR 0007).
const IMAGE_CACHE = "public, max-age=0, must-revalidate";

/** Stable validator for one uploaded image; a replacement gets a fresh opaque storage key. */
function imageEtag(storageKey: string): string {
  return `"${Bun.hash(storageKey).toString(36)}"`;
}

/** Public editor emoticons; only editor-visible sets are returned. */
export async function listEmoticonsResponse(sql: SQL): Promise<Response> {
  return Response.json(
    { sets: await listEditorEmoticons(sql) },
    { headers: { "cache-control": PUBLIC_CACHE } },
  );
}

/**
 * Emoticon images may be replaced in place, so they revalidate instead of being immutable.
 * Browsers and the CDN keep the bytes but ask again; the differing ETag fetches the new file.
 */
export async function emoticonImageResponse(
  sql: SQL,
  storage: StorageClient,
  id: string,
  request?: Request,
): Promise<Response> {
  const image = await readEmoticonImage(sql, id);

  if (image === null) {
    return Response.json({ code: "not_found" }, { status: 404 });
  }

  const etag = imageEtag(image.storageKey);
  const validators = { "cache-control": IMAGE_CACHE, etag };

  if (request?.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: validators });
  }

  try {
    const bytes = await storage.get(image.storageKey);

    return new Response(bytes, {
      headers: {
        ...validators,
        "content-type": image.contentType,
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return Response.json({ code: "not_found" }, { status: 404 });
  }
}
