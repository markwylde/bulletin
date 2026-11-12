import {
  DEV_THEME_PRIVATE_KEY,
  DEV_THEME_PUBLIC_KEY,
  decodeThemeBundle,
  encodeThemeBundle,
  loadThemeResources,
  parseJwk,
  readThemeDetail,
  signThemeBundle,
  type ThemeBundleAsset,
  type ThemeBundleManifest,
  type ThemeBundleString,
  type ThemeSource,
  verifyThemeBundle,
} from "@bulletin/domain/themes";
import { opaqueKey, type StorageClient } from "@bulletin/storage";
import { loadTheme } from "@bulletin/templates";
import type { SQL } from "bun";
import { fileTypeFromBuffer } from "file-type";
import type { JWK } from "jose";
import { compactVerify, importJWK } from "jose";
import { userAppBaseCatalog } from "./theme-catalog.ts";
import { checkThemeBundle, type ThemeCheckIssue } from "./theme-checks.ts";

const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const ASSET_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "font/woff",
  "font/woff2",
  "font/ttf",
  "font/otf",
]);
const THEME_NAME = /^[a-z][a-z0-9_-]{0,60}$/;

export type BundleInstallResult =
  | { readonly ok: true; readonly id: string }
  | {
      readonly ok: false;
      readonly code:
        | "invalid_signature"
        | "invalid_bundle"
        | "invalid_asset"
        | "checks_failed"
        | "duplicate_name"
        | "parent_not_found"
        | "marketplace_unavailable"
        | "package_not_found";
      readonly issues?: readonly ThemeCheckIssue[];
      readonly detail?: string;
    };

export function themeSigningKey(): JWK | null {
  const fromEnv = Bun.env.BULLETIN_THEME_PRIVATE_KEY;

  if (fromEnv !== undefined) {
    return parseJwk(fromEnv);
  }

  return process.env.NODE_ENV === "production" ? null : DEV_THEME_PRIVATE_KEY;
}

export function marketplacePublicKey(): JWK | null {
  const fromEnv = Bun.env.BULLETIN_THEME_MARKETPLACE_PUBLIC_KEY;

  if (fromEnv !== undefined) {
    return parseJwk(fromEnv);
  }

  return process.env.NODE_ENV === "production" ? null : DEV_THEME_PUBLIC_KEY;
}

function stringsOf(resources: Awaited<ReturnType<typeof loadThemeResources>>): ThemeBundleString[] {
  const strings: ThemeBundleString[] = [];

  for (const locale of ["en", "es", "fr"] as const) {
    for (const [key, value] of Object.entries(resources.strings[locale])) {
      strings.push({ locale, key, value });
    }
  }

  return strings;
}

/** Exports the resolved theme (including inherited content) as a signed tar bundle. */
export async function exportThemeBundle(
  sql: SQL,
  storage: StorageClient,
  themeId: string,
  signingKey: JWK,
): Promise<{
  readonly bundle: Uint8Array;
  readonly signature: string;
  readonly filename: string;
} | null> {
  const detail = await readThemeDetail(sql, themeId);

  if (detail === null) {
    return null;
  }

  const loaded = await loadTheme(sql, themeId);

  if (loaded === null) {
    return null;
  }

  const resources = await loadThemeResources(
    sql,
    loaded.chain.map((entry) => entry.id),
  );
  const assets: ThemeBundleAsset[] = [];
  const files = new Map<string, Uint8Array>();

  for (const asset of resources.assets) {
    const bytes = await storage.get(asset.storageKey).catch(() => null);

    if (bytes === null) {
      return null;
    }

    assets.push({
      name: asset.name,
      contentType: asset.contentType,
      file: `assets/${asset.name}`,
    });
    files.set(asset.name, bytes);
  }

  const templates = Object.fromEntries(
    [...loaded.templates.entries()].flatMap(([name, candidates]) => {
      const first = candidates[0];
      return first === undefined ? [] : [[name, first.body]];
    }),
  );
  const manifest: ThemeBundleManifest = {
    format: "bulletin-theme",
    formatVersion: 1,
    name: detail.name,
    parent: null,
    description: detail.description,
    version: detail.version,
    templates,
    tokens: resources.tokens,
    css: resources.css,
    strings: stringsOf(resources),
    assets,
  };
  const bundle = encodeThemeBundle(manifest, files);

  return {
    bundle,
    signature: signThemeBundle(bundle, signingKey),
    filename: `${detail.name}-${detail.version}.tar`,
  };
}

interface AssetWrite {
  readonly key: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly name: string;
}

async function install(
  sql: SQL,
  storage: StorageClient,
  actorId: string,
  manifest: ThemeBundleManifest,
  assets: ReadonlyMap<string, Uint8Array>,
  source: ThemeSource,
  signature: string,
): Promise<BundleInstallResult> {
  if (!THEME_NAME.test(manifest.name)) {
    return { ok: false, code: "invalid_bundle" };
  }

  const checks = await checkThemeBundle(manifest, await userAppBaseCatalog());

  if (!checks.ok) {
    return { ok: false, code: "checks_failed", issues: checks.issues };
  }

  const writes: AssetWrite[] = [];

  for (const asset of manifest.assets) {
    const bytes = assets.get(asset.name);

    if (bytes === undefined || bytes.byteLength === 0 || bytes.byteLength > MAX_ASSET_BYTES) {
      return { ok: false, code: "invalid_asset", detail: asset.name };
    }

    const detected = await fileTypeFromBuffer(bytes);

    if (detected === undefined || !ASSET_TYPES.has(detected.mime)) {
      return { ok: false, code: "invalid_asset", detail: asset.name };
    }

    writes.push({
      key: opaqueKey("theme"),
      name: asset.name,
      contentType: detected.mime,
      bytes: bytes.byteLength,
    });
  }

  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('bulletin.theme_install'))`;

      const [duplicate] = (await tx`
        SELECT 1 FROM core.themes WHERE name = ${manifest.name}
      `) as unknown[];

      if (duplicate !== undefined) {
        return { ok: false as const, code: "duplicate_name" as const };
      }

      let parentId: string | null = null;

      if (manifest.parent !== null) {
        const [parent] = (await tx`
          SELECT id::text AS id FROM core.themes WHERE name = ${manifest.parent}
        `) as Array<{ id: string }>;

        if (parent === undefined) {
          return { ok: false as const, code: "parent_not_found" as const };
        }

        parentId = parent.id;
      }

      const [theme] = (await tx`
        INSERT INTO core.themes (name, parent_id, version, source, description, signature, created_by)
        VALUES (${manifest.name}, ${parentId}, ${manifest.version}, ${source},
          ${manifest.description}, ${signature}, ${actorId})
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (theme === undefined) {
        throw new Error("Could not install the theme");
      }

      for (const [name, body] of Object.entries(manifest.templates)) {
        await tx`
          INSERT INTO core.theme_templates (theme_id, name, body, updated_by)
          VALUES (${theme.id}, ${name}, ${body}, ${actorId})
        `;
        await tx`
          INSERT INTO core.theme_template_versions (theme_id, name, version, body, updated_by)
          VALUES (${theme.id}, ${name}, 1, ${body}, ${actorId})
        `;
      }

      for (const scheme of ["light", "dark"] as const) {
        if (Object.keys(manifest.tokens[scheme]).length > 0) {
          await tx`
            INSERT INTO core.theme_tokens (theme_id, scheme, tokens)
            VALUES (${theme.id}, ${scheme}, ${JSON.stringify(manifest.tokens[scheme])}::jsonb)
          `;
        }
      }

      if (checks.css !== "") {
        await tx`
          INSERT INTO core.theme_css (theme_id, css) VALUES (${theme.id}, ${checks.css})
        `;
      }

      for (const entry of manifest.strings) {
        await tx`
          INSERT INTO core.theme_strings (theme_id, locale, key, value)
          VALUES (${theme.id}, ${entry.locale}, ${entry.key}, ${entry.value})
        `;
      }

      for (const [index, asset] of manifest.assets.entries()) {
        const write = writes[index];

        if (write === undefined) {
          throw new Error("Asset write order changed");
        }

        const bytes = assets.get(asset.name);

        if (bytes === undefined) {
          throw new Error("Asset bytes disappeared");
        }

        await storage.put(write.key, bytes, { contentType: write.contentType });
        await tx`
          INSERT INTO core.theme_assets (theme_id, name, storage_key, content_type, bytes, created_by)
          VALUES (${theme.id}, ${write.name}, ${write.key}, ${write.contentType},
            ${write.bytes}, ${actorId})
        `;
      }

      return { ok: true as const, id: theme.id };
    });
  } catch (error) {
    for (const write of writes) {
      await storage.delete(write.key).catch(() => undefined);
    }

    throw error;
  }
}

export async function installThemeBundle(
  sql: SQL,
  storage: StorageClient,
  actorId: string,
  bundle: Uint8Array,
  signature: string,
  publicKey: JWK,
  source: "upload" | "marketplace",
): Promise<BundleInstallResult> {
  if (!verifyThemeBundle(bundle, signature, publicKey)) {
    return { ok: false, code: "invalid_signature" };
  }

  const decoded = decodeThemeBundle(bundle);

  if (decoded === null) {
    return { ok: false, code: "invalid_bundle" };
  }

  return install(sql, storage, actorId, decoded.manifest, decoded.assets, source, signature);
}

export interface MarketplaceThemePackage {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
}

interface MarketplaceCatalog {
  readonly version: number;
  readonly packages: readonly (MarketplaceThemePackage & {
    readonly type: string;
    readonly bundleUrl: string;
    readonly signatureUrl: string;
  })[];
}

const MARKETPLACE_TIMEOUT_MS = 10_000;

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(MARKETPLACE_TIMEOUT_MS) });

    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(MARKETPLACE_TIMEOUT_MS) });

    if (!response.ok) {
      return null;
    }

    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

async function marketplaceCatalog(
  baseUrl: string,
  publicKey: JWK,
): Promise<MarketplaceCatalog | null> {
  const signed = await fetchText(`${baseUrl.replace(/\/+$/, "")}/catalog.jws`);

  if (signed === null) {
    return null;
  }

  try {
    const key = await importJWK(publicKey, "EdDSA");
    const verified = await compactVerify(signed, key);
    const catalog = JSON.parse(new TextDecoder().decode(verified.payload)) as MarketplaceCatalog;

    return Array.isArray(catalog.packages) ? catalog : null;
  } catch {
    return null;
  }
}

/** Theme packages from the signed catalogue, for the staff install screen. */
export async function marketplaceThemePackages(
  baseUrl: string,
  publicKey: JWK,
): Promise<readonly MarketplaceThemePackage[] | null> {
  const catalog = await marketplaceCatalog(baseUrl, publicKey);

  return catalog === null
    ? null
    : catalog.packages
        .filter((entry) => entry.type === "theme")
        .map(({ id, name, version, description }) => ({ id, name, version, description }));
}

/** Installs one theme package from the signed marketplace catalogue (task 3.2). */
export async function installMarketplaceTheme(
  sql: SQL,
  storage: StorageClient,
  actorId: string,
  input: { readonly baseUrl: string; readonly packageId: string; readonly publicKey: JWK },
): Promise<BundleInstallResult> {
  const catalog = await marketplaceCatalog(input.baseUrl, input.publicKey);

  if (catalog === null) {
    return { ok: false, code: "marketplace_unavailable" };
  }

  const pkg = catalog.packages.find(
    (entry) => entry.id === input.packageId && entry.type === "theme",
  );

  if (pkg === undefined) {
    return { ok: false, code: "package_not_found" };
  }

  const base = input.baseUrl.replace(/\/+$/, "");
  const bundleUrl = new URL(pkg.bundleUrl, `${base}/`).toString();
  const signatureUrl = new URL(pkg.signatureUrl, `${base}/`).toString();
  const [bundle, signature] = await Promise.all([fetchBytes(bundleUrl), fetchText(signatureUrl)]);

  if (bundle === null || signature === null) {
    return { ok: false, code: "marketplace_unavailable" };
  }

  return installThemeBundle(
    sql,
    storage,
    actorId,
    bundle,
    signature.trim(),
    input.publicKey,
    "marketplace",
  );
}
