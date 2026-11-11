import { type AvatarVariant, avatarKey, type StorageClient } from "@bulletin/storage";

/** Public, content-hashed avatar objects are immutable, so browser and CDN cache them for a year. */
export const AVATAR_CACHE = "public, max-age=31536000, immutable";
export const AVATAR_PRESIGN_EXPIRES_IN = 7 * 24 * 60 * 60;

const FILE = /^([0-9a-f]{64})-(lg|md|sm)\.webp$/;

function notFound(): Response {
  return Response.json(
    { code: "not_found" },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}

/**
 * `GET /avatars/<member>/<sha256>-<size>.webp` (task 5.2). The stable content-hashed URL
 * redirects to the files origin; a new avatar changes the hash and therefore the URL.
 */
export async function avatarImageResponse(
  storage: StorageClient,
  memberId: string,
  file: string,
): Promise<Response> {
  const match = FILE.exec(file);

  if (match === null || match[1] === undefined || match[2] === undefined) {
    return notFound();
  }

  const hash = match[1];
  const variant = match[2] as AvatarVariant;
  let key: string;

  try {
    key = avatarKey(memberId, hash, variant);
  } catch {
    return notFound();
  }

  if (!(await storage.exists(key))) {
    return notFound();
  }

  const location = storage.presignGet(key, {
    expiresIn: AVATAR_PRESIGN_EXPIRES_IN,
    responseContentType: "image/webp",
    responseContentDisposition: 'inline; filename="avatar.webp"',
  });

  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": AVATAR_CACHE },
  });
}
