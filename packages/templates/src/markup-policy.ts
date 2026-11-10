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
  // A scripting browser parses noscript content as raw text, so the same bytes can be inert
  // for the markup parser and live for the browser. Removing the element outright keeps both
  // parse modes safe.
  noscript: true,
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
 * The base a form target is resolved against. It only exists so the URL parser applies the
 * browser's own normalisation (backslashes become slashes, control characters are stripped);
 * it is never a real host.
 */
const FORM_TARGET_BASE = "https://theme-form.invalid/";
const FORM_TARGET_ORIGIN = new URL(FORM_TARGET_BASE).origin;

/**
 * Form targets must stay on this origin (ADR 0008). Empty values, fragment- and query-only
 * references, root-relative and plain relative paths are same-origin; absolute URLs,
 * protocol-relative references and backslash tricks such as `/\evil.example/collect` (which
 * the URL parser folds to `//evil.example/collect`) are not.
 */
export function isSameOriginTarget(value: string): boolean {
  const trimmed = value.trim();

  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("?")) {
    return true;
  }

  // An explicit scheme is always off-origin for a form; check the normalised form so a tab or
  // newline inside the scheme cannot hide it.
  if (/^[a-z][a-z0-9+.-]*:/i.test(normaliseUrl(trimmed))) {
    return false;
  }

  try {
    return new URL(trimmed, FORM_TARGET_BASE).origin === FORM_TARGET_ORIGIN;
  } catch {
    return false;
  }
}

/** True when a URL attribute value on a rendered element must be removed. */
export function isForbiddenUrlAttribute(name: string, value: string): boolean {
  if (URL_LIST_ATTRIBUTES.has(name)) {
    return srcsetUrls(value).some((url) => hasForbiddenScheme(url));
  }

  return hasForbiddenScheme(value);
}
