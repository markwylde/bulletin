/**
 * Object key conventions (ADR 0019). Keys are opaque: metadata lives in `core.attachments`
 * and the database is authoritative, so nothing may infer meaning from a key beyond the
 * prefix that routes it to a bucket lifecycle.
 */

export const KEY_PREFIXES = [
  "att",
  "av",
  "theme",
  "plugin",
  "export",
  "emoticon",
  "unfurl",
] as const;
export type KeyPrefix = (typeof KEY_PREFIXES)[number];

/** Images are delivered in three square sizes; the largest is the profile view. */
export const AVATAR_VARIANTS = ["lg", "md", "sm"] as const;
export type AvatarVariant = (typeof AVATAR_VARIANTS)[number];

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function segment(value: string): string {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`Unsafe object key segment: ${value}`);
  }

  return value;
}

/** Opaque, non-guessable keys; metadata in the database is authoritative (ADR 0019). */
export function opaqueKey(prefix: KeyPrefix = "att", id: string = crypto.randomUUID()): string {
  return `${prefix}/${segment(id)}`;
}

/** Presigned PUT target before finalisation. Replayable, so nothing reads it after the snapshot. */
export function quarantineKey(id: string = crypto.randomUUID()): string {
  return `quarantine/${segment(id)}`;
}

/** Immutable snapshot written by finalise; every later processing step reads only this. */
export function processingKey(id: string): string {
  return `processing/${segment(id)}`;
}

/** Final attachment object, published only once its bytes have been verified. */
export function attachmentKey(id: string): string {
  return `att/${segment(id)}`;
}

/**
 * Public, content-hashed avatar object (`av/<member>/<sha256>-<variant>.webp`). A new avatar
 * changes the hash, so old URLs stay cacheable forever (ADR 0019).
 */
export function avatarKey(memberId: string, sha256: string, variant: AvatarVariant): string {
  if (!SHA256_HEX.test(sha256)) {
    throw new Error("Avatar hashes must be lowercase SHA-256 hex");
  }

  return `av/${segment(memberId)}/${sha256}-${variant}.webp`;
}

/** Re-encoded unfurl preview image, fetched and stored by the worker (ADR 0019). */
export function unfurlImageKey(sha256: string): string {
  if (!SHA256_HEX.test(sha256)) {
    throw new Error("Unfurl image hashes must be lowercase SHA-256 hex");
  }

  return `unfurl/${sha256}`;
}

/** True when a bucket key belongs to one of the opaque key spaces Bulletin writes. */
export function isManagedKey(key: string): boolean {
  const prefix = key.split("/")[0];
  return (
    KEY_PREFIXES.includes(prefix as KeyPrefix) || prefix === "quarantine" || prefix === "processing"
  );
}
