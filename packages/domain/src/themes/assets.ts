import sharp from "sharp";

export const THEME_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
] as const;
export const THEME_FONT_TYPES = ["font/woff", "font/woff2", "font/ttf", "font/otf"] as const;

export type ThemeAssetType = (typeof THEME_IMAGE_TYPES)[number] | (typeof THEME_FONT_TYPES)[number];

export function isThemeAssetType(value: string): value is ThemeAssetType {
  return (
    (THEME_IMAGE_TYPES as readonly string[]).includes(value) ||
    (THEME_FONT_TYPES as readonly string[]).includes(value)
  );
}

export interface SanitisedThemeAsset {
  readonly bytes: Uint8Array;
  readonly contentType: ThemeAssetType;
}

/**
 * Re-encodes uploaded images so EXIF/GPS and other metadata never reach the public theme
 * asset (ADR 0012). Fonts carry no image metadata and are stored unchanged.
 */
export async function sanitizeThemeAsset(
  bytes: Uint8Array,
  contentType: ThemeAssetType,
): Promise<SanitisedThemeAsset> {
  if (!isThemeAssetType(contentType) || contentType.startsWith("font/")) {
    return { bytes, contentType };
  }

  const animated = contentType === "image/gif";
  const image = sharp(bytes, {
    failOn: "error",
    limitInputPixels: 4096 * 4096,
    animated,
  }).rotate();
  let output: Buffer;

  switch (contentType) {
    case "image/png":
      output = await image.png({ compressionLevel: 9 }).toBuffer();
      break;
    case "image/jpeg":
      output = await image.jpeg({ quality: 90 }).toBuffer();
      break;
    case "image/webp":
      output = await image.webp({ quality: 90 }).toBuffer();
      break;
    case "image/gif":
      output = await image.gif().toBuffer();
      break;
    case "image/avif":
      output = await image.avif({ quality: 60 }).toBuffer();
      break;
    default:
      return { bytes, contentType };
  }

  return { bytes: new Uint8Array(output), contentType };
}
