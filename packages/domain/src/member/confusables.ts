import raw from "./confusables.json";

/**
 * Unicode 10.0.0 UTS #39 `confusables.txt`, via the MIT-licensed
 * `unicode-confusables@0.1.1` dataset. Regenerate this file when the Unicode
 * version moves; the data is intentionally checked in so server builds stay offline.
 */
export const CONFUSABLES_VERSION = "Unicode 10.0.0 UTS #39";

export const CONFUSABLES: Readonly<Record<string, string>> = raw as Record<string, string>;
