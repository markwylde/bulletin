import { listEditorEmoticons, readEmoticonImage } from "@bulletin/domain/content";
import type { StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";

const PUBLIC_CACHE = "public, s-maxage=60, stale-while-revalidate=60";

/** Public editor emoticons; only editor-visible sets are returned. */
export async function listEmoticonsResponse(sql: SQL): Promise<Response> {
  return Response.json(
    { sets: await listEditorEmoticons(sql) },
    { headers: { "cache-control": PUBLIC_CACHE } },
  );
}

/** Emoticon images are public and immutable once uploaded. */
export async function emoticonImageResponse(
  sql: SQL,
  storage: StorageClient,
  id: string,
): Promise<Response> {
  const image = await readEmoticonImage(sql, id);

  if (image === null) {
    return Response.json({ code: "not_found" }, { status: 404 });
  }

  try {
    const bytes = await storage.get(image.storageKey);

    return new Response(bytes, {
      headers: {
        "content-type": image.contentType,
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return Response.json({ code: "not_found" }, { status: 404 });
  }
}
