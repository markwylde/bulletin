/** Constant until `groups-permissions` replaces it with a group setting. */
export const NAME_CHANGE_INTERVAL_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * A compact UTS #39-style skeleton table. It covers the shipped locales (Latin with
 * diacritics) plus the common Cyrillic, Greek, fullwidth and digit lookalikes. Extend it
 * when a new script is added; `core.members.name_skeleton` carries the unique index.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic
  а: "a",
  в: "b",
  г: "r",
  е: "e",
  ё: "e",
  і: "i",
  ї: "i",
  ј: "j",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  п: "n",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  ь: "b",
  ѕ: "s",
  ԁ: "d",
  һ: "h",
  ӏ: "l",
  ԛ: "q",
  ԝ: "w",
  // Greek
  α: "a",
  β: "b",
  γ: "y",
  δ: "d",
  ε: "e",
  ζ: "z",
  η: "n",
  ι: "i",
  κ: "k",
  λ: "l",
  μ: "u",
  ν: "v",
  ο: "o",
  ρ: "p",
  σ: "o",
  ς: "o",
  τ: "t",
  υ: "u",
  φ: "f",
  χ: "x",
  ψ: "w",
  ω: "w",
  // Latin lookalikes and compatibility letters
  æ: "ae",
  ß: "ss",
  ı: "i",
  ł: "l",
  ø: "o",
  đ: "d",
  ħ: "h",
  ŋ: "n",
  ɑ: "a",
  ɡ: "g",
  ɪ: "i",
  ʟ: "l",
  ᴍ: "m",
  ɴ: "n",
  ᴏ: "o",
  ᴘ: "p",
  ʀ: "r",
  ꜱ: "s",
  ᴛ: "t",
  ᴜ: "u",
  ᴠ: "v",
  ᴡ: "w",
  ʏ: "y",
  ᴢ: "z",
  // Digits commonly used as letters
  "0": "o",
  "1": "l",
  "3": "e",
  "5": "s",
  "7": "t",
};

/** NFKD + combining-mark removal + lookalike folding + case/space normalisation. */
export function displayNameSkeleton(name: string): string {
  const decomposed = name.normalize("NFKD").toLowerCase();
  const stripped = decomposed.replace(/\p{M}+/gu, "").replace(/\p{Cf}+/gu, "");
  let skeleton = "";

  for (const character of stripped) {
    skeleton += CONFUSABLES[character] ?? character;
  }

  return skeleton.replace(/\s+/gu, " ").trim();
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
