/**
 * The theme markup policy shared by save-time validation (`validate.ts`) and render-time
 * sanitising (`sanitise.ts`): ADR 0008 rejects later execution paths, the sanitiser strips
 * the same constructs from dynamically assembled output.
 */

/** ADR 0008 theme profile: elements a theme may never emit. */
export const BANNED_ELEMENTS: Readonly<Record<string, true>> = {
  script: true,
  iframe: true,
  frame: true,
  frameset: true,
  object: true,
  embed: true,
  applet: true,
  base: true,
};

export const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  "href",
  "src",
  "srcset",
  "action",
  "formaction",
  "xlink:href",
  "poster",
  "background",
  "data",
  "cite",
  "longdesc",
  "manifest",
  "ping",
]);

/** Attributes whose values are a URL list rather than a single URL. */
export const URL_LIST_ATTRIBUTES: ReadonlySet<string> = new Set(["srcset"]);

/** Strips the whitespace and control characters browsers ignore in a URL scheme, then lowercases. */
export function normaliseUrl(value: string): string {
  let normalised = "";

  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;

    if (code > 0x20 && code !== 0x7f) {
      normalised += character;
    }
  }

  return normalised.toLowerCase();
}

export function hasForbiddenScheme(value: string): boolean {
  const normalised = normaliseUrl(value);
  return (
    normalised.startsWith("javascript:") ||
    normalised.startsWith("vbscript:") ||
    normalised.startsWith("data:")
  );
}

export function srcsetUrls(value: string): readonly string[] {
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
    .filter((candidate) => candidate !== "");
}

/**
 * Form targets must stay on this origin (ADR 0008). Empty, fragment, query, root-relative and
 * plain relative targets are same-origin; absolute and protocol-relative targets are not.
 */
export function isSameOriginTarget(value: string): boolean {
  const trimmed = value.trim();

  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("?")) {
    return true;
  }

  if (trimmed.startsWith("//") || trimmed.startsWith("\\")) {
    return false;
  }

  if (trimmed.startsWith("/")) {
    return true;
  }

  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

/** True when a URL attribute value on a rendered element must be removed. */
export function isForbiddenUrlAttribute(name: string, value: string): boolean {
  if (URL_LIST_ATTRIBUTES.has(name)) {
    return srcsetUrls(value).some((url) => hasForbiddenScheme(url));
  }

  return hasForbiddenScheme(value);
}
