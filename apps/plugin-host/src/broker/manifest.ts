import { join } from "node:path";

/** Subset of `plugin.json` the broker spike needs. */
export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly sdkVersion: string;
  readonly entry: string;
  /** Hosts the plugin may reach through the egress proxy. Exact, lowercase DNS names. */
  readonly egressHosts: readonly string[];
  /** Migration files relative to the bundle root, run as the plugin's owner role. */
  readonly migrations: readonly string[];
}

export interface PluginMigration {
  readonly name: string;
  readonly sql: string;
}

// The id also becomes a database role and schema: `plugin_<id>_owner` must fit in 63 bytes.
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,48}$/;
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const MIGRATION_PATTERN = /^[a-z0-9][a-z0-9/_-]*\.sql$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];

  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`plugin.json: ${key} must be a non-empty string`);
  }

  return value;
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];

  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`plugin.json: ${key} must be an array of strings`);
  }

  return value as string[];
}

function validateEgressHost(host: string): string {
  const normalized = host.toLowerCase();

  if (
    normalized !== host ||
    normalized.length > 253 ||
    !HOST_PATTERN.test(normalized) ||
    normalized.includes("..") ||
    normalized.startsWith(".") ||
    normalized.endsWith(".")
  ) {
    throw new TypeError(`plugin.json: invalid egress host: ${host}`);
  }

  return normalized;
}

function validateMigrationPath(path: string): string {
  if (
    path.startsWith("/") ||
    path.includes("..") ||
    path.includes("\\") ||
    !MIGRATION_PATTERN.test(path)
  ) {
    throw new TypeError(`plugin.json: invalid migration path: ${path}`);
  }

  return path;
}

/** Parses and validates `plugin.json`. Unknown fields are ignored. */
export function parsePluginManifest(value: unknown): PluginManifest {
  if (!isRecord(value)) {
    throw new TypeError("plugin.json must contain an object");
  }

  const id = stringField(value, "id");

  if (!ID_PATTERN.test(id)) {
    throw new TypeError("plugin.json: id must be 1-55 lowercase letters, digits or hyphens");
  }

  const entry = stringField(value, "entry");

  if (entry.startsWith("/") || entry.includes("..")) {
    throw new TypeError("plugin.json: entry must be a relative path inside the bundle");
  }

  return {
    id,
    name: stringField(value, "name"),
    version: stringField(value, "version"),
    sdkVersion: stringField(value, "sdkVersion"),
    entry,
    egressHosts: stringArray(value, "egressHosts").map(validateEgressHost),
    migrations: stringArray(value, "migrations").map(validateMigrationPath),
  };
}

export async function loadPluginManifest(bundlePath: string): Promise<PluginManifest> {
  const text = await Bun.file(join(bundlePath, "plugin.json")).text();

  try {
    return parsePluginManifest(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError(`plugin.json is not valid JSON: ${error.message}`);
    }

    throw error;
  }
}

/** Reads every declared migration in order. */
export async function loadPluginMigrations(
  bundlePath: string,
  manifest: PluginManifest,
): Promise<PluginMigration[]> {
  return Promise.all(
    manifest.migrations.map(async (name) => ({
      name,
      sql: await Bun.file(join(bundlePath, name)).text(),
    })),
  );
}
