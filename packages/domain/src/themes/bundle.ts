import { isLocale, type Locale } from "@bulletin/i18n";

export const THEME_BUNDLE_FORMAT = "bulletin-theme";
export const THEME_BUNDLE_VERSION = 1;
export const THEME_BUNDLE_MAX_BYTES = 10 * 1024 * 1024;

export interface ThemeBundleAsset {
  readonly name: string;
  readonly contentType: string;
  /** Path inside the tar, always `assets/<name>`. */
  readonly file: string;
}

export interface ThemeBundleString {
  readonly locale: Locale;
  readonly key: string;
  readonly value: string;
}

export interface ThemeBundleManifest {
  readonly format: typeof THEME_BUNDLE_FORMAT;
  readonly formatVersion: typeof THEME_BUNDLE_VERSION;
  readonly name: string;
  /** A parent theme this bundle extends; null makes it a complete standalone theme. */
  readonly parent: string | null;
  readonly description: string;
  readonly version: number;
  readonly templates: Readonly<Record<string, string>>;
  readonly tokens: Readonly<Record<"light" | "dark", Readonly<Record<string, string>>>>;
  readonly css: string;
  readonly strings: readonly ThemeBundleString[];
  readonly assets: readonly ThemeBundleAsset[];
}

export interface DecodedThemeBundle {
  readonly manifest: ThemeBundleManifest;
  readonly assets: ReadonlyMap<string, Uint8Array>;
}

const THEME_NAME = /^[a-z][a-z0-9_-]{0,60}$/;
const TEMPLATE_NAME = /^[a-z][a-z0-9_.-]{0,80}$/;
const ASSET_NAME = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const STRING_KEY = /^[A-Za-z0-9_.-]{1,160}$/;
const TOKEN_NAME = /^[a-z][a-z0-9-]{0,50}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function tokenMap(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }

  const tokens: Record<string, string> = {};

  for (const [key, token] of Object.entries(value)) {
    if (!TOKEN_NAME.test(key) || typeof token !== "string" || token.length > 120) {
      return null;
    }

    tokens[key] = token;
  }

  return tokens;
}

/** Parses and validates the JSON manifest before any template or asset is touched. */
export function parseThemeBundleManifest(value: unknown): ThemeBundleManifest | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.format !== THEME_BUNDLE_FORMAT || value.formatVersion !== THEME_BUNDLE_VERSION) {
    return null;
  }

  const name = stringValue(value.name, 60);
  const parent =
    value.parent === null || value.parent === undefined ? null : stringValue(value.parent, 60);
  const description = stringValue(value.description ?? "", 2_000);
  const css = stringValue(value.css ?? "", 200_000);
  const version = typeof value.version === "number" ? value.version : Number.NaN;

  if (
    name === null ||
    !THEME_NAME.test(name) ||
    (parent !== null && !THEME_NAME.test(parent)) ||
    description === null ||
    css === null ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    return null;
  }

  if (!isRecord(value.templates)) {
    return null;
  }

  const templates: Record<string, string> = {};

  for (const [template, body] of Object.entries(value.templates)) {
    if (!TEMPLATE_NAME.test(template) || typeof body !== "string" || body.length > 1_000_000) {
      return null;
    }

    templates[template] = body;
  }

  if (!isRecord(value.tokens)) {
    return null;
  }

  const light = tokenMap(value.tokens.light);
  const dark = tokenMap(value.tokens.dark);

  if (light === null || dark === null) {
    return null;
  }

  if (!Array.isArray(value.strings)) {
    return null;
  }

  const strings: ThemeBundleString[] = [];

  for (const entry of value.strings) {
    if (!isRecord(entry)) {
      return null;
    }

    const locale = entry.locale;
    const key = stringValue(entry.key, 160);
    const stringBody = stringValue(entry.value, 5_000);

    if (
      typeof locale !== "string" ||
      !isLocale(locale) ||
      key === null ||
      !STRING_KEY.test(key) ||
      stringBody === null
    ) {
      return null;
    }

    strings.push({ locale, key, value: stringBody });
  }

  if (!Array.isArray(value.assets)) {
    return null;
  }

  const assets: ThemeBundleAsset[] = [];
  const files = new Set<string>();

  for (const entry of value.assets) {
    if (!isRecord(entry)) {
      return null;
    }

    const assetName = stringValue(entry.name, 80);
    const contentType = stringValue(entry.contentType, 100);
    const file = stringValue(entry.file, 120);

    if (
      assetName === null ||
      !ASSET_NAME.test(assetName) ||
      contentType === null ||
      file === null ||
      file !== `assets/${assetName}` ||
      files.has(file)
    ) {
      return null;
    }

    files.add(file);
    assets.push({ name: assetName, contentType, file });
  }

  return {
    format: THEME_BUNDLE_FORMAT,
    formatVersion: THEME_BUNDLE_VERSION,
    name,
    parent,
    description,
    version,
    templates,
    tokens: { light, dark },
    css,
    strings,
    assets,
  };
}

interface TarEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

function octal(value: number, size: number): string {
  return `${value.toString(8).padStart(size - 1, "0")}\0`;
}

function header(name: string, size: number): Uint8Array {
  const block = new Uint8Array(512);
  const write = (value: string, offset: number, length: number): void => {
    block.set(new TextEncoder().encode(value).subarray(0, length), offset);
  };

  write(name, 0, 100);
  write(octal(0o644, 8), 100, 8);
  write(octal(0, 8), 108, 8);
  write(octal(0, 8), 116, 8);
  write(octal(size, 12), 124, 12);
  write(octal(Math.floor(Date.now() / 1_000), 12), 136, 12);
  write("        ", 148, 8);
  write("0", 156, 1);
  write("ustar", 257, 5);
  write("00", 263, 2);
  write("bulletin", 265, 32);
  write("bulletin", 297, 32);
  write(octal(0, 8), 329, 8);
  write(octal(0, 8), 337, 8);

  let checksum = 0;

  for (const byte of block) {
    checksum += byte;
  }

  write(octal(checksum, 8), 148, 8);

  return block;
}

/** Minimal ustar encoder: regular files only, short names, deterministic contents. */
export function encodeThemeTar(entries: readonly TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];

  for (const entry of entries) {
    if (entry.name.length === 0 || entry.name.length > 100 || entry.name.includes("\\")) {
      throw new Error(`Unsafe tar entry name: ${entry.name}`);
    }

    chunks.push(header(entry.name, entry.data.byteLength));
    chunks.push(entry.data);
    const padding = (512 - (entry.data.byteLength % 512)) % 512;

    if (padding > 0) {
      chunks.push(new Uint8Array(padding));
    }
  }

  chunks.push(new Uint8Array(1024));

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return out;
}

function readString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);

  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
}

function readOctal(block: Uint8Array, offset: number, length: number): number | null {
  const value = readString(block, offset, length).trim();

  if (value === "" || !/^[0-7]+$/.test(value)) {
    return null;
  }

  return Number.parseInt(value, 8);
}

/** Decodes a bundle tar, rejecting traversal, links, directories and malformed checksums. */
export function decodeThemeTar(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> | null {
  if (bytes.byteLength === 0 || bytes.byteLength > THEME_BUNDLE_MAX_BYTES) {
    return null;
  }

  const entries = new Map<string, Uint8Array>();
  let offset = 0;

  while (offset + 512 <= bytes.byteLength) {
    const block = bytes.subarray(offset, offset + 512);

    if (block.every((byte) => byte === 0)) {
      return entries;
    }

    const name = readString(block, 0, 100);
    const size = readOctal(block, 124, 12);
    const storedChecksum = readOctal(block, 148, 8);
    const type = readString(block, 156, 1) || "0";

    if (name === "" || size === null || storedChecksum === null || type !== "0") {
      return null;
    }

    if (
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      return null;
    }

    let checksum = 0;

    for (let index = 0; index < 512; index += 1) {
      checksum += index >= 148 && index < 156 ? 32 : (block[index] ?? 0);
    }

    if (checksum !== storedChecksum) {
      return null;
    }

    const start = offset + 512;
    const end = start + size;

    if (end > bytes.byteLength) {
      return null;
    }

    entries.set(name, bytes.subarray(start, end));
    offset = start + Math.ceil(size / 512) * 512;
  }

  return null;
}

/** Builds the tar for an exported/resolved theme. */
export function encodeThemeBundle(
  manifest: ThemeBundleManifest,
  assets: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  const entries: TarEntry[] = [
    {
      name: "theme.json",
      data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    },
  ];

  for (const asset of manifest.assets) {
    const data = assets.get(asset.name);

    if (data === undefined) {
      throw new Error(`Bundle asset ${asset.name} has no bytes`);
    }

    entries.push({ name: asset.file, data });
  }

  return encodeThemeTar(entries);
}

/** Parses a bundle tar. The manifest and every referenced asset must be present. */
export function decodeThemeBundle(bytes: Uint8Array): DecodedThemeBundle | null {
  const entries = decodeThemeTar(bytes);

  if (entries === null) {
    return null;
  }

  const manifestBytes = entries.get("theme.json");

  if (manifestBytes === undefined) {
    return null;
  }

  let value: unknown;

  try {
    value = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    return null;
  }

  const manifest = parseThemeBundleManifest(value);

  if (manifest === null) {
    return null;
  }

  const assets = new Map<string, Uint8Array>();

  for (const asset of manifest.assets) {
    const data = entries.get(asset.file);

    if (data === undefined || data.byteLength === 0) {
      return null;
    }

    assets.set(asset.name, data);
  }

  return { manifest, assets };
}
