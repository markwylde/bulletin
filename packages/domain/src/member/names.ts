import { CONFUSABLES } from "./confusables.ts";

/** Constant until `groups-permissions` replaces it with a group setting. */
export const NAME_CHANGE_INTERVAL_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * UTS #39 confusable skeleton: NFKD and case fold, apply the versioned confusables
 * mapping to a fixed point, then remove combining marks, format characters and
 * collapse whitespace.
 */
export function displayNameSkeleton(name: string): string {
  let value = name.normalize("NFKD").toLowerCase();

  for (let pass = 0; pass < 4; pass += 1) {
    let next = "";

    for (const character of value) {
      next += CONFUSABLES[character] ?? character;
    }

    if (next === value) {
      break;
    }

    value = next;
  }

  return value
    .toLowerCase()
    .replace(/\p{M}+/gu, "")
    .replace(/\p{Cf}+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export interface ValidDisplayName {
  readonly ok: true;
  readonly name: string;
  readonly skeleton: string;
}

export interface InvalidDisplayName {
  readonly ok: false;
  readonly code: "display_name_invalid";
}

/** 3–32 code points, no control/format characters, trimmed. */
export function validateDisplayName(value: unknown): ValidDisplayName | InvalidDisplayName {
  if (typeof value !== "string") {
    return { ok: false, code: "display_name_invalid" };
  }

  const name = value.trim();
  const length = [...name].length;

  if (length < 3 || length > 32 || /\p{Cc}/u.test(name) || /\p{Cf}/u.test(name)) {
    return { ok: false, code: "display_name_invalid" };
  }

  return { ok: true, name, skeleton: displayNameSkeleton(name) };
}
