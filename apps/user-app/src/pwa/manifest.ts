/**
 * The web app manifest is generated per theme (ADR 0014): the board name, colours and icons
 * come from the theme the viewer is currently rendering, so an installed app matches the
 * forum's palette and cannot be cached across a theme change.
 */

export interface ManifestTokens {
  readonly bg: string;
  readonly accent: string;
}

export interface ManifestTheme {
  readonly id: string;
  readonly version: number;
  readonly tokens: ManifestTokens;
}

export interface WebAppManifest {
  readonly name: string;
  readonly short_name: string;
  readonly description: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display: "standalone";
  readonly background_color: string;
  readonly theme_color: string;
  readonly icons: readonly {
    readonly src: string;
    readonly sizes: string;
    readonly type: "image/png";
    readonly purpose: "any" | "maskable";
  }[];
}

/** A theme reference from the URL: `/manifest.webmanifest?theme=<id>[@<version>]`. */
export interface ThemeReference {
  readonly id: string;
  readonly version: number | null;
}

const THEME_REFERENCE = /^(\d{1,9})(?:@(\d{1,9}))?$/;

/** Parses the cache-busting `theme=<id>@<version>` query used by the manifest and icons. */
export function parseThemeReference(value: string | null | undefined): ThemeReference | null {
  const match = THEME_REFERENCE.exec(value ?? "");

  if (match === null) {
    return null;
  }

  return {
    id: match[1] ?? "",
    version: match[2] === undefined ? null : Number(match[2]),
  };
}

/** Manifest icon URLs carry the theme reference so a theme update replaces the cached icon. */
export function themeQuery(theme: ManifestTheme): string {
  return `theme=${encodeURIComponent(`${theme.id}@${theme.version}`)}`;
}

export function iconUrl(theme: ManifestTheme, size: number): string {
  return `/pwa/icon-${size}.png?${themeQuery(theme)}`;
}

export interface ManifestInput {
  readonly boardName: string;
  readonly description: string;
  readonly theme: ManifestTheme;
}

/** Builds the manifest object the endpoint serialises. */
export function buildManifest(input: ManifestInput): WebAppManifest {
  const name = input.boardName.trim();

  return {
    name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    description: input.description,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: input.theme.tokens.bg,
    theme_color: input.theme.tokens.accent,
    icons: [
      {
        src: iconUrl(input.theme, 192),
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: iconUrl(input.theme, 512),
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: iconUrl(input.theme, 512),
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

const DEFAULT_BG = "#f4f6f9";
const DEFAULT_ACCENT = "#3157c7";

/** Theme tokens are admin-editable; the manifest only trusts safe CSS colour values. */
export function manifestTokens(tokens: Readonly<Record<string, string>>): ManifestTokens {
  const bg = tokens.bg?.trim() ?? "";
  const accent = tokens.accent?.trim() ?? "";

  return {
    bg: /^#[0-9a-f]{6}$/i.test(bg) ? bg : DEFAULT_BG,
    accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent : DEFAULT_ACCENT,
  };
}

/** The icon letter is the first visible character of the board name, or `B`. */
export function iconLetter(boardName: string): string {
  const first = [...boardName.trim()][0];
  return first === undefined ? "B" : first.toUpperCase();
}

const XML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => XML_ESCAPES[character] ?? character);
}

/**
 * The icon is drawn as SVG with the theme's own colours and then rasterised by the icon route
 * (a manifest needs 192 and 512 pixel raster icons for installability).
 */
export function iconSvg(input: {
  readonly size: number;
  readonly tokens: ManifestTokens;
  readonly letter: string;
}): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${input.size}" height="${input.size}" viewBox="0 0 512 512" role="img">
  <rect width="512" height="512" rx="112" fill="${input.tokens.bg}"/>
  <circle cx="256" cy="256" r="176" fill="${input.tokens.accent}"/>
  <text x="256" y="330" text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="208" font-weight="700" fill="${input.tokens.bg}">${escapeXml(input.letter)}</text>
</svg>`;
}
