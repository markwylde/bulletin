import { createHash } from "node:crypto";
import { type SdkCompatibility, sdkCompatibility } from "@bulletin/plugin-sdk/semver";
import type { JWK } from "jose";
import { compactVerify, decodeProtectedHeader, importJWK } from "jose";
import { verifyThemeBundle } from "../themes/signing.ts";

/** Marketplace browsing and verification (ADR 0009, task 4.1). */

export interface PluginCatalogPackage {
  readonly id: string;
  readonly type: "plugin";
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  readonly sdkVersion: string;
  readonly sdkMajor: number;
  readonly capabilities: readonly string[];
  readonly bundleUrl: string;
  readonly signatureUrl: string;
  /** Lowercase hex sha256 of the downloaded bundle. */
  readonly sha256: string;
}

export interface PluginCatalog {
  readonly version: number;
  readonly generatedAt: string;
  readonly packages: readonly PluginCatalogPackage[];
}

export interface MarketplaceEntry extends PluginCatalogPackage {
  readonly compatibility: SdkCompatibility;
  readonly installable: boolean;
}

export class CatalogError extends Error {
  readonly code:
    | "signature"
    | "catalog"
    | "checksum"
    | "bundle_signature"
    | "not_found"
    | "incompatible";

  constructor(code: CatalogError["code"], message: string) {
    super(message);
    this.name = "CatalogError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown, max = 4_000): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

/** Parses only plugin packages; the mock also carries theme packages. */
export function parsePluginCatalog(value: unknown): PluginCatalog {
  if (!isRecord(value) || !Array.isArray(value.packages)) {
    throw new CatalogError("catalog", "Catalog has no packages");
  }

  const packages: PluginCatalogPackage[] = [];

  for (const entry of value.packages) {
    if (!isRecord(entry) || entry.type !== "plugin") {
      continue;
    }

    const id = string(entry.id, 49);
    const name = string(entry.name, 200);
    const version = string(entry.version, 40);
    const description = string(entry.description);
    const author = string(entry.author, 200);
    const sdkVersion = string(entry.sdkVersion, 40);
    const bundleUrl = string(entry.bundleUrl);
    const signatureUrl = string(entry.signatureUrl);
    const sha256 = string(entry.sha256, 64);
    const capabilities = Array.isArray(entry.capabilities)
      ? entry.capabilities.filter((item): item is string => typeof item === "string")
      : [];

    if (
      id === undefined ||
      name === undefined ||
      version === undefined ||
      description === undefined ||
      author === undefined ||
      sdkVersion === undefined ||
      bundleUrl === undefined ||
      signatureUrl === undefined ||
      sha256 === undefined ||
      !/^[0-9a-f]{64}$/.test(sha256)
    ) {
      throw new CatalogError("catalog", "Catalog contains an invalid plugin package");
    }

    packages.push({
      id,
      type: "plugin",
      name,
      version,
      description,
      author,
      sdkVersion,
      sdkMajor: Number(/^(\d+)/.exec(sdkVersion)?.[1] ?? "0"),
      capabilities,
      bundleUrl,
      signatureUrl,
      sha256,
    });
  }

  return {
    version: typeof value.version === "number" ? value.version : 1,
    generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : "",
    packages,
  };
}

/** Verifies the compact JWS and returns the catalog payload. */
export async function verifyCatalogJws(jws: string, keys: readonly JWK[]): Promise<PluginCatalog> {
  try {
    const header = decodeProtectedHeader(jws);
    const key = keys.find((candidate) => candidate.kid === header.kid) ?? keys[0];

    if (key === undefined) {
      throw new CatalogError("signature", "Catalog signing key is unknown");
    }

    const { payload } = await compactVerify(jws, await importJWK(key, "EdDSA"));
    return parsePluginCatalog(JSON.parse(new TextDecoder().decode(payload)));
  } catch (error) {
    if (error instanceof CatalogError) {
      throw error;
    }

    throw new CatalogError("signature", "Catalog signature is not valid");
  }
}

export async function fetchCatalog(options: {
  readonly baseUrl: string;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<readonly MarketplaceEntry[]> {
  const request = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const base = options.baseUrl.replace(/\/+$/, "");
  const keyResponse = await request(`${base}/keys.json`);

  if (!keyResponse.ok) {
    throw new CatalogError("signature", "Marketplace keys are unavailable");
  }

  const keysBody = (await keyResponse.json()) as { keys?: unknown };

  if (!Array.isArray(keysBody.keys)) {
    throw new CatalogError("signature", "Marketplace keys are malformed");
  }

  const jwsResponse = await request(`${base}/catalog.jws`);

  if (!jwsResponse.ok) {
    throw new CatalogError("catalog", "Marketplace catalog is unavailable");
  }

  const catalog = await verifyCatalogJws(await jwsResponse.text(), keysBody.keys as JWK[]);

  return catalog.packages.map((entry) => {
    const compatibility = sdkCompatibility(entry.sdkVersion);
    return {
      ...entry,
      compatibility,
      installable: compatibility.compatible,
    };
  });
}

export interface CapabilityReview {
  readonly capability: string;
  readonly labelKey: string;
  readonly elevated: boolean;
}

const ELEVATED = new Set(["core.read", "core.write", "pii", "gdpr"]);

/** Plain-language capability list for the install review, including elevated access. */
export function reviewCapabilities(
  capabilities: readonly string[],
  egressHosts: readonly string[],
): readonly CapabilityReview[] {
  return [
    ...capabilities.map((capability) => ({
      capability,
      labelKey: `staff.plugins.capability.${capability.replaceAll(".", "_")}`,
      elevated: ELEVATED.has(capability),
    })),
    ...egressHosts.map((host) => ({
      capability: `egress:${host}`,
      labelKey: "staff.plugins.capability.egressHost",
      elevated: false,
    })),
  ];
}

/** Downloads a bundle and verifies the catalog checksum and detached signature. */
export async function downloadVerifiedBundle(options: {
  readonly entry: PluginCatalogPackage;
  readonly baseUrl?: string;
  readonly keys: readonly JWK[];
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<Uint8Array> {
  const request = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const base = options.baseUrl?.replace(/\/+$/, "") ?? "";
  const resolve = (url: string): string => (/^https?:/.test(url) ? url : `${base}${url}`);
  const [bundleResponse, signatureResponse] = await Promise.all([
    request(resolve(options.entry.bundleUrl)),
    request(resolve(options.entry.signatureUrl)),
  ]);

  if (!bundleResponse.ok || !signatureResponse.ok) {
    throw new CatalogError("checksum", "Bundle download failed");
  }

  const bundle = new Uint8Array(await bundleResponse.arrayBuffer());
  const checksum = createHash("sha256").update(bundle).digest("hex");

  if (checksum !== options.entry.sha256) {
    throw new CatalogError("checksum", "Bundle checksum does not match the catalog");
  }

  const signature = (await signatureResponse.text()).trim();
  const key = options.keys[0];

  if (key === undefined || !verifyThemeBundle(bundle, signature, key)) {
    throw new CatalogError("bundle_signature", "Bundle signature is not valid");
  }

  return bundle;
}
