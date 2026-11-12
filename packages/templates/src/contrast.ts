/**
 * Design tokens and WCAG contrast for themes (ADR 0008, task 1.1). Theme editors and the
 * install checks use this module; the default theme's tokens live next to its templates.
 */

/** The two colour schemes every theme ships (ADR 0008). */
export const THEME_SCHEMES = ["light", "dark"] as const;
export type ThemeScheme = (typeof THEME_SCHEMES)[number];

/** One scheme's tokens, keyed like the CSS custom property without its `--bl-` prefix. */
export type SchemeTokens = Readonly<Record<string, string>>;
export type ThemeTokens = Readonly<Record<ThemeScheme, SchemeTokens>>;

export interface ContrastPair {
  /** Token name used for text or a UI glyph. */
  readonly foreground: string;
  /** Token name of the surface it is drawn on. */
  readonly background: string;
}

/**
 * The pairs the default theme uses for text and UI. Borders are not text and brand colours
 * used only as fills are excluded; every pair here meets WCAG AA normal text.
 */
export const DEFAULT_THEME_CONTRAST_PAIRS: readonly ContrastPair[] = [
  { foreground: "text", background: "bg" },
  { foreground: "text", background: "surface" },
  { foreground: "text", background: "surface-muted" },
  { foreground: "text", background: "accent-soft" },
  { foreground: "muted", background: "bg" },
  { foreground: "muted", background: "surface" },
  { foreground: "muted", background: "surface-muted" },
  { foreground: "muted", background: "accent-soft" },
  { foreground: "accent", background: "bg" },
  { foreground: "accent", background: "surface" },
  { foreground: "accent", background: "surface-muted" },
  { foreground: "accent", background: "accent-soft" },
  { foreground: "danger", background: "bg" },
  { foreground: "danger", background: "surface" },
  { foreground: "danger", background: "surface-muted" },
  { foreground: "danger", background: "accent-soft" },
  { foreground: "accent-text", background: "accent" },
];

/** WCAG 2.1 AA for normal-size text. Large text may use 3:1. */
export const WCAG_AA_NORMAL_TEXT = 4.5;

export interface ContrastIssue {
  readonly scheme: ThemeScheme;
  readonly foreground: string;
  readonly background: string;
  /** `null` when a token is missing or is not a supported hex colour. */
  readonly ratio: number | null;
  readonly minimum: number;
  readonly reason: "contrast" | "invalid_colour";
}

interface Rgb {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

const HEX_COLOUR = /^#([\da-f]{6})$/i;

function parseHexColour(value: string): Rgb | null {
  const match = HEX_COLOUR.exec(value.trim());

  if (match?.[1] === undefined) {
    return null;
  }

  const hex = match[1];

  return {
    red: Number.parseInt(hex.slice(0, 2), 16),
    green: Number.parseInt(hex.slice(2, 4), 16),
    blue: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#rrggbb` colour, or `null` when the value is not one. */
export function relativeLuminance(value: string): number | null {
  const rgb = parseHexColour(value);

  if (rgb === null) {
    return null;
  }

  return (
    0.2126 * channelLuminance(rgb.red) +
    0.7152 * channelLuminance(rgb.green) +
    0.0722 * channelLuminance(rgb.blue)
  );
}

/** WCAG contrast ratio between two `#rrggbb` colours, or `null` for an invalid value. */
export function contrastRatio(foreground: string, background: string): number | null {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);

  if (foregroundLuminance === null || backgroundLuminance === null) {
    return null;
  }

  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Checks one scheme's token pairs. Missing tokens and unscannable colours are failures, so a
 * theme can never pass by omitting a token the check expects.
 */
export function checkContrast(
  scheme: ThemeScheme,
  tokens: SchemeTokens,
  pairs: readonly ContrastPair[] = DEFAULT_THEME_CONTRAST_PAIRS,
  minimum = WCAG_AA_NORMAL_TEXT,
): readonly ContrastIssue[] {
  const issues: ContrastIssue[] = [];

  for (const pair of pairs) {
    const foreground = tokens[pair.foreground];
    const background = tokens[pair.background];
    const ratio =
      foreground === undefined || background === undefined
        ? null
        : contrastRatio(foreground, background);

    if (ratio === null) {
      issues.push({
        scheme,
        foreground: pair.foreground,
        background: pair.background,
        ratio,
        minimum,
        reason: "invalid_colour",
      });
      continue;
    }

    if (ratio < minimum) {
      issues.push({
        scheme,
        foreground: pair.foreground,
        background: pair.background,
        ratio,
        minimum,
        reason: "contrast",
      });
    }
  }

  return issues;
}

/** Checks both schemes of a theme. Empty means every pair meets WCAG AA. */
export function checkThemeContrast(
  tokens: ThemeTokens,
  pairs: readonly ContrastPair[] = DEFAULT_THEME_CONTRAST_PAIRS,
  minimum = WCAG_AA_NORMAL_TEXT,
): readonly ContrastIssue[] {
  return THEME_SCHEMES.flatMap((scheme) => checkContrast(scheme, tokens[scheme], pairs, minimum));
}
