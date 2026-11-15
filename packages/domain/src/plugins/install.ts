import { type PluginManifest, parsePluginManifest } from "@bulletin/plugin-sdk/manifest";
import type { SQL } from "bun";
import { decodeThemeTar } from "../themes/bundle.ts";
import {
  CatalogError,
  downloadVerifiedPluginBundle,
  fetchCatalog,
  fetchMarketplaceKeys,
  type MarketplaceEntry,
  type VerifiedBundle,
} from "./catalog.ts";

/**
 * Marketplace install plumbing shared by staff-api (review, approve, store) and plugin-host
 * (run what is stored). The durable request is the `core.plugins` row; this channel only wakes
 * plugin-host up to reconcile (ADR 0003, 0009).
 */
export const PLUGINS_NOTIFY_CHANNEL = "bulletin_plugins";

/** Wakes every plugin-host to reconcile; inside a transaction it fires on commit. */
export async function notifyPluginHost(sql: SQL, pluginId: string): Promise<void> {
  await sql`SELECT pg_notify(${PLUGINS_NOTIFY_CHANNEL}, ${pluginId})`;
}

export interface UnpackedPlugin {
  readonly manifest: PluginManifest;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

/** Decodes a plugin tar and parses its manifest; traversal and links are rejected. */
export function unpackPluginBundle(bundle: Uint8Array): UnpackedPlugin {
  const files = decodeThemeTar(bundle);
  const manifestBytes = files?.get("plugin.json");

  if (files === null || manifestBytes === undefined) {
    throw new CatalogError("catalog", "The plugin bundle is not a valid archive");
  }

  let raw: unknown;

  try {
    raw = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new CatalogError("catalog", "The plugin manifest is not valid JSON");
  }

  const manifest = parsePluginManifest(raw);

  if (!files.has(manifest.entry)) {
    throw new CatalogError("catalog", "The plugin bundle has no server entry");
  }

  for (const migration of manifest.migrations) {
    if (!files.has(migration)) {
      throw new CatalogError("catalog", `The plugin bundle is missing ${migration}`);
    }
  }

  return { manifest, files };
}

export interface MarketplacePlugin extends UnpackedPlugin {
  readonly entry: MarketplaceEntry;
  readonly verified: VerifiedBundle;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Fetches one plugin from the signed catalog, verifies its checksum and signature, and checks
 * the manifest inside matches the catalog entry, so the reviewed capabilities are the ones the
 * bundle will ask for.
 */
export async function fetchMarketplacePlugin(options: {
  readonly baseUrl: string;
  readonly pluginId: string;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<MarketplacePlugin> {
  const catalog = await fetchCatalog({
    baseUrl: options.baseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const entry = catalog.find((candidate) => candidate.id === options.pluginId);

  if (entry === undefined) {
    throw new CatalogError("not_found", `Plugin ${options.pluginId} is not in the catalog`);
  }

  if (!entry.installable) {
    throw new CatalogError("incompatible", `Plugin ${entry.id} needs SDK ${entry.sdkVersion}`);
  }

  const keys = await fetchMarketplaceKeys({
    baseUrl: options.baseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const verified = await downloadVerifiedPluginBundle({
    entry,
    baseUrl: options.baseUrl,
    keys,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const unpacked = unpackPluginBundle(verified.bundle);

  if (
    unpacked.manifest.id !== entry.id ||
    unpacked.manifest.version !== entry.version ||
    !sameSet(unpacked.manifest.capabilities, entry.capabilities)
  ) {
    throw new CatalogError("catalog", "The plugin manifest does not match its catalog entry");
  }

  return { ...unpacked, entry, verified };
}

/** What an admin approved on the review screen. */
export interface PluginApproval {
  readonly capabilities: readonly string[];
  readonly egressHosts: readonly string[];
}

/**
 * The admin must approve exactly what the bundle asks for: an approval that leaves something
 * out, or adds something, is not an approval of this bundle (ADR 0009).
 */
export function approvalMatches(manifest: PluginManifest, approval: PluginApproval): boolean {
  if (manifest.egressHosts.length > 0 && !manifest.capabilities.includes("egress")) {
    return false;
  }

  return (
    sameSet(manifest.capabilities, approval.capabilities) &&
    sameSet(manifest.egressHosts, approval.egressHosts)
  );
}
