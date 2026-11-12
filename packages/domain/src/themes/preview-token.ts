import { createHmac, timingSafeEqual } from "node:crypto";

export const THEME_PREVIEW_TTL_MS = 10 * 60 * 1_000;
const PURPOSE = "bulletin.theme-preview.v1";

export interface ThemePreviewClaims {
  readonly themeId: string;
  readonly memberId: string;
  readonly expiresAt: number;
}

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`${PURPOSE}\n${payload}`).digest();
}

/** A signed, short-lived preview token: theme id, admin member id and expiry (ADR 0008). */
export function createThemePreviewToken(
  input: { readonly themeId: string; readonly memberId: string; readonly expiresAt?: number },
  secret: string,
): string {
  const claims: ThemePreviewClaims = {
    themeId: input.themeId,
    memberId: input.memberId,
    expiresAt: input.expiresAt ?? Date.now() + THEME_PREVIEW_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");

  return `${payload}.${signature(payload, secret).toString("base64url")}`;
}

/** Verifies the signature and expiry; returns null for any malformed or expired token. */
export function verifyThemePreviewToken(
  token: string | null | undefined,
  secret: string,
  now = Date.now(),
): ThemePreviewClaims | null {
  if (token === null || token === undefined || token.length > 2_000) {
    return null;
  }

  const parts = token.split(".");

  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    return null;
  }

  const expected = signature(parts[0], secret);
  let provided: Buffer;

  try {
    provided = Buffer.from(parts[1], "base64url");
  } catch {
    return null;
  }

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  let claims: unknown;

  try {
    claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof claims !== "object" || claims === null) {
    return null;
  }

  const record = claims as Record<string, unknown>;

  if (
    typeof record.themeId !== "string" ||
    !/^\d+$/.test(record.themeId) ||
    typeof record.memberId !== "string" ||
    !/^\d+$/.test(record.memberId) ||
    typeof record.expiresAt !== "number" ||
    !Number.isSafeInteger(record.expiresAt)
  ) {
    return null;
  }

  if (record.expiresAt <= now) {
    return null;
  }

  return {
    themeId: record.themeId,
    memberId: record.memberId,
    expiresAt: record.expiresAt,
  };
}
