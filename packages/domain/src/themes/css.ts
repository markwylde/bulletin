import { type Image, transform, type Url, type Visitor } from "lightningcss";

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

function imageUrls(image: Image, invalid: string[]): void {
  if (image.type === "url") {
    if (!isThemeAssetUrl(image.value.url)) {
      invalid.push(image.value.url);
    }

    return;
  }

  if (image.type === "image-set") {
    for (const option of image.value.options) {
      imageUrls(option.image, invalid);
    }
  }
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
  const invalidUrls: string[] = [];
  const visitor: Visitor<never> = {
    Url(url: Url) {
      if (!isThemeAssetUrl(url.url)) {
        invalidUrls.push(url.url);
      }
    },
    Image(image) {
      imageUrls(image, invalidUrls);
    },
  };

  try {
    // First pass: visit every image/url node, including image-set entries.
    transform({
      filename: "theme.css",
      code: new TextEncoder().encode(source),
      minify: false,
      errorRecovery: false,
      visitor,
    });
    // Second pass: keep lightningcss's normalised output (the visitor can simplify images).
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

  if (invalidUrls.length > 0) {
    const detail = invalidUrls[0]?.slice(0, 120);
    return { ok: false, code: "external_url", ...(detail === undefined ? {} : { detail }) };
  }

  // lightningcss recovers from some incomplete declarations instead of throwing.
  if (/:\s*;/.test(css) || (css.match(/{/g)?.length ?? 0) !== (css.match(/}/g)?.length ?? 0)) {
    return { ok: false, code: "syntax" };
  }

  if (/@import\b/i.test(css)) {
    return { ok: false, code: "import" };
  }

  // Defense in depth: a resource scheme that slipped past the AST (e.g. a vendor image
  // function lightningcss preserves as a raw token) is still refused.
  if (/(?:https?:|data:|javascript:|vbscript:)/i.test(css)) {
    return { ok: false, code: "external_url" };
  }

  for (const match of css.matchAll(URL_PATTERN)) {
    const url = match[1] ?? match[2] ?? match[3] ?? "";

    if (!isThemeAssetUrl(url)) {
      return { ok: false, code: "external_url", detail: url.slice(0, 120) };
    }
  }

  return { ok: true, css };
}

export interface CssResponsiveIssue {
  readonly property: string;
  readonly value: string;
}

/**
 * Static mobile-width check (ADR 0014): a fixed horizontal size wider than 360 px makes every
 * page with that theme scroll sideways on the smallest supported screen. The design's
 * install-time check rejects it before a browser is involved.
 */
export function responsiveStyleIssue(property: string, value: string): CssResponsiveIssue | null {
  const name = property.trim().toLowerCase();

  if (!["min-width", "width", "min-inline-size", "inline-size"].includes(name)) {
    return null;
  }

  const size = /^(\d+(?:\.\d+)?)(px|rem|vw)$/i.exec(value.trim());

  if (size === null) {
    return null;
  }

  const number = Number(size[1]);
  const unit = size[2]?.toLowerCase();
  const tooWide =
    (unit === "px" && number > 360) ||
    (unit === "rem" && number > 22.5) ||
    (unit === "vw" && number > 100);

  return tooWide ? { property: name, value: value.trim() } : null;
}

export function responsiveCssIssues(source: string): readonly CssResponsiveIssue[] {
  const issues: CssResponsiveIssue[] = [];
  const pattern = /(?:^|[;{])\s*(min-width|width|min-inline-size|inline-size)\s*:\s*([^;{}]+)/gi;

  for (const match of source.matchAll(pattern)) {
    const property = match[1];
    const value = match[2]?.trim();

    if (property === undefined || value === undefined) {
      continue;
    }

    const issue = responsiveStyleIssue(property, value);

    if (issue !== null) {
      issues.push(issue);
    }
  }

  return issues;
}

/** True when a token value contains any URL/image resource, including escaped spellings. */
export function cssValueHasResource(value: string): boolean {
  const found: string[] = [];
  const visitor: Visitor<never> = {
    Url(url) {
      found.push(url.url);
    },
    Image(image) {
      imageUrls(image, found);
    },
  };

  try {
    transform({
      filename: "token.css",
      code: new TextEncoder().encode(`:root { --bl-token: ${value}; }`),
      minify: false,
      errorRecovery: false,
      visitor,
    });
  } catch {
    return true;
  }

  return found.length > 0;
}
