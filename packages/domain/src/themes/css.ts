import { transform } from "lightningcss";

export type ThemeCssErrorCode = "syntax" | "import" | "external_url" | "expression" | "too_large";

export type ThemeCssFilterResult =
  | { readonly ok: true; readonly css: string }
  | { readonly ok: false; readonly code: ThemeCssErrorCode; readonly detail?: string };

export const THEME_CSS_MAX_BYTES = 200_000;

const ALLOWED_URL_PREFIX = "/theme-assets/";
const URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi;

function isThemeAssetUrl(value: string): boolean {
  const path = value.trim();

  return (
    path.startsWith(ALLOWED_URL_PREFIX) &&
    path.length <= 240 &&
    !/[\\?#]/.test(path) &&
    !path.includes("..")
  );
}

/**
 * Parses and filters custom theme CSS (ADR 0008). lightningcss normalises the stylesheet,
 * which also resolves CSS escapes such as `u\72l(`, so the checks below cannot be bypassed
 * by encoding an external import or URL. Only same-origin theme assets may be referenced.
 */
export function filterThemeCss(source: string): ThemeCssFilterResult {
  if (new TextEncoder().encode(source).byteLength > THEME_CSS_MAX_BYTES) {
    return { ok: false, code: "too_large" };
  }

  if (/expression\s*\(/i.test(source) || /-moz-binding|behavior\s*:/i.test(source)) {
    return { ok: false, code: "expression" };
  }

  let css: string;

  try {
    css = new TextDecoder().decode(
      transform({
        filename: "theme.css",
        code: new TextEncoder().encode(source),
        minify: false,
        errorRecovery: false,
      }).code,
    );
  } catch {
    return { ok: false, code: "syntax" };
  }

  // lightningcss recovers from some incomplete declarations instead of throwing.
  if (/:\s*;/.test(css) || (css.match(/{/g)?.length ?? 0) !== (css.match(/}/g)?.length ?? 0)) {
    return { ok: false, code: "syntax" };
  }

  if (/@import\b/i.test(css)) {
    return { ok: false, code: "import" };
  }

  for (const match of css.matchAll(URL_PATTERN)) {
    const url = match[1] ?? match[2] ?? match[3] ?? "";

    if (!isThemeAssetUrl(url)) {
      return { ok: false, code: "external_url", detail: url.slice(0, 120) };
    }
  }

  return { ok: true, css };
}
