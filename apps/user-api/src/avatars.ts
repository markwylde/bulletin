import { AVATAR_SIZES, processAvatarImage } from "@bulletin/domain/attachments/processing";
import {
  clearMemberAvatar,
  readAvatarPolicy,
  readMemberAvatar,
  setMemberAvatar,
} from "@bulletin/domain/member";
import { type AvatarVariant, avatarKey, type StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";

const NO_STORE = { "cache-control": "no-store" } as const;
const AVATAR_VARIANTS = Object.keys(AVATAR_SIZES) as AvatarVariant[];

interface Session {
  readonly memberId: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function bodyRecord(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);

  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function avatarUrl(memberId: string, hash: string): string {
  return `/avatars/${memberId}/${hash}-md.webp`;
}

async function deleteAvatarObjects(
  storage: StorageClient,
  memberId: string,
  hash: string | null,
): Promise<void> {
  if (hash === null) {
    return;
  }

  await Promise.all(
    AVATAR_VARIANTS.map((variant) =>
      storage.delete(avatarKey(memberId, hash, variant)).catch(() => undefined),
    ),
  );
}

/**
 * `POST /api/me/avatar` (task 5.1): validates the group limit and staff block, crops the image
 * through sharp into the three public sizes, stores them under `av/<member>/<hash>-<size>.webp`
 * and bumps `member:{id}` in the same transaction as the member row.
 */
export async function avatarUploadResponse(
  sql: SQL,
  storage: StorageClient,
  session: Session,
  request: Request,
): Promise<Response> {
  const body = await bodyRecord(request);
  const raw = body?.imageBase64;

  if (typeof raw !== "string" || raw === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    return json({ code: "avatar_invalid" }, 400);
  }

  const policy = await readAvatarPolicy(sql, session.memberId);

  if (policy === null) {
    return json({ code: "not_found" }, 404);
  }

  if (policy.maxBytes === 0) {
    return json({ code: "avatar_not_allowed" }, 403);
  }

  if (policy.blockedUntil !== null && policy.blockedUntil.getTime() > Date.now()) {
    return json({ code: "avatar_blocked" }, 403);
  }

  if (raw.length > Math.ceil((policy.maxBytes * 4) / 3) + 8) {
    return json({ code: "avatar_too_large", maxBytes: policy.maxBytes }, 413);
  }

  const bytes = new Uint8Array(Buffer.from(raw, "base64"));

  if (bytes.byteLength === 0) {
    return json({ code: "avatar_invalid" }, 400);
  }
  if (bytes.byteLength > policy.maxBytes) {
    return json({ code: "avatar_too_large", maxBytes: policy.maxBytes }, 413);
  }

  let processed: Awaited<ReturnType<typeof processAvatarImage>>;

  try {
    processed = await processAvatarImage(bytes);
  } catch {
    return json({ code: "avatar_invalid" }, 400);
  }

  const previous = await readMemberAvatar(sql, session.memberId);

  for (const variant of AVATAR_VARIANTS) {
    await storage.put(
      avatarKey(session.memberId, processed.hash, variant),
      processed.sizes[variant],
      {
        contentType: "image/webp",
      },
    );
  }

  const stored = await setMemberAvatar(sql, session.memberId, processed.hash);

  if (!stored) {
    await deleteAvatarObjects(storage, session.memberId, processed.hash);
    return json({ code: "not_found" }, 404);
  }

  await deleteAvatarObjects(storage, session.memberId, previous?.hash ?? null);

  return json({ avatarUrl: avatarUrl(session.memberId, processed.hash) });
}

/** `POST /api/me/avatar/remove`: clears the member's avatar and its public objects. */
export async function avatarRemoveResponse(
  sql: SQL,
  storage: StorageClient,
  session: Session,
): Promise<Response> {
  const previous = await readMemberAvatar(sql, session.memberId);

  if (previous === null) {
    return json({ code: "not_found" }, 404);
  }

  await clearMemberAvatar(sql, session.memberId);
  await deleteAvatarObjects(storage, session.memberId, previous.hash);

  return json({ ok: true });
}
