/**
 * `plugin.json` schema (ADR 0009). The same parser is used by the SDK at build time and by
 * plugin-host at install time, so a bundle that compiles cannot describe hooks the host
 * cannot install.
 */

export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,48}$/;
const NAME = /^[a-z][a-z0-9_.-]{0,80}$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const ENTRY = /^[^/\\][^\\]*$/;

export const PLUGIN_CAPABILITIES = [
  "db",
  "core.read",
  "core.write",
  "events",
  "jobs",
  "kv",
  "cache.invalidate",
  "egress",
  "template",
  "enricher",
  "filter",
  "veto",
  "route",
  "client",
  "settings",
  "pii",
  "gdpr",
] as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export interface TemplateFragmentManifest {
  readonly name: string;
  /** `hook` injects at a named point; `override` replaces a theme fragment with that name. */
  readonly kind: "hook" | "override";
  readonly body: string;
  /** Cache tags the fragment's data depends on, e.g. `leaderboard`. */
  readonly deps?: readonly string[];
}

export interface EnricherManifest {
  readonly hook: string;
  readonly fields: readonly string[];
  readonly deps?: readonly string[];
  readonly timeoutMs?: number;
}

export interface FilterManifest {
  readonly hook: string;
  readonly priority?: number;
  readonly timeoutMs?: number;
}

export interface VetoManifest extends FilterManifest {
  /** Admin-chosen behaviour when the sandbox is down; fail-open is the default. */
  readonly failMode?: "open" | "closed";
  /** i18n key used when the veto rejects a write. */
  readonly reasonKey: string;
}

export interface RouteManifest {
  /** Path under the plugin namespace, e.g. `leaderboard` or `tip/<postId>`. */
  readonly path: string;
  readonly kind: "page" | "api";
}

export interface JobManifest {
  readonly name: string;
  /** Cron expression for a scheduled job; queued jobs omit it. */
  readonly schedule?: string;
}

export interface ClientAppManifest {
  readonly name: string;
  readonly entry: string;
  /** Template hooks that render this app in a sandboxed frame. */
  readonly hooks: readonly string[];
}

export interface PersonalDataManifest {
  readonly table: string;
  readonly memberColumn: string;
}

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly sdkVersion: string;
  readonly entry: string;
  readonly capabilities: readonly PluginCapability[];
  readonly egressHosts: readonly string[];
  readonly migrations: readonly string[];
  readonly templateFragments: readonly TemplateFragmentManifest[];
  readonly enrichers: readonly EnricherManifest[];
  readonly filters: readonly FilterManifest[];
  readonly vetoes: readonly VetoManifest[];
  readonly events: readonly string[];
  readonly contentExtensions: readonly string[];
  readonly routes: readonly RouteManifest[];
  readonly jobs: readonly JobManifest[];
  readonly clientApps: readonly ClientAppManifest[];
  readonly settings: Readonly<Record<string, unknown>> | null;
  readonly forumActions: readonly string[];
  readonly flags: readonly string[];
  readonly personalData: readonly PersonalDataManifest[];
  readonly i18n: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface ManifestIssue {
  readonly path: string;
  readonly message: string;
}

export class ManifestError extends Error {
  readonly issues: readonly ManifestIssue[];

  constructor(issues: readonly ManifestIssue[]) {
    super(
      `Invalid plugin.json:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`,
    );
    this.name = "ManifestError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  issues: ManifestIssue[],
  path: string,
  pattern?: RegExp,
): string {
  const value = record[key];

  if (typeof value !== "string" || value.trim() === "") {
    issues.push({ path: `${path}.${key}`, message: "must be a non-empty string" });
    return "";
  }

  if (pattern !== undefined && !pattern.test(value)) {
    issues.push({ path: `${path}.${key}`, message: `has an invalid format: ${value}` });
  }

  return value;
}

function stringArray(
  record: Record<string, unknown>,
  key: string,
  issues: ManifestIssue[],
  path: string,
): string[] {
  const value = record[key];

  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    issues.push({ path: `${path}.${key}`, message: "must be an array of strings" });
    return [];
  }

  return value as string[];
}

function arrayOf(
  record: Record<string, unknown>,
  key: string,
  issues: ManifestIssue[],
  path: string,
  parse: (value: unknown, issues: ManifestIssue[], path: string) => unknown,
): unknown[] {
  const value = record[key];

  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    issues.push({ path: `${path}.${key}`, message: "must be an array" });
    return [];
  }

  return value.map((entry, index) => parse(entry, issues, `${path}.${key}[${String(index)}]`));
}

function hookName(name: string, issues: ManifestIssue[], path: string): string {
  if (!NAME.test(name)) {
    issues.push({ path, message: `invalid hook name: ${name}` });
  }

  return name;
}

function parseFragment(
  value: unknown,
  issues: ManifestIssue[],
  path: string,
): TemplateFragmentManifest {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return { name: "", kind: "hook", body: "" };
  }

  const name = hookName(stringField(value, "name", issues, path), issues, `${path}.name`);
  const kind = value.kind === "override" ? "override" : "hook";
  const body = typeof value.body === "string" ? value.body : "";

  if (body.trim() === "") {
    issues.push({ path: `${path}.body`, message: "must be a non-empty string" });
  }

  if (body.length > 256 * 1024) {
    issues.push({ path: `${path}.body`, message: "is larger than 256 KiB" });
  }

  return {
    name,
    kind,
    body,
    deps: stringArray(value, "deps", issues, path),
  };
}

function parseEnricher(value: unknown, issues: ManifestIssue[], path: string): EnricherManifest {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return { hook: "", fields: [] };
  }

  return {
    hook: hookName(String(value.hook ?? ""), issues, `${path}.hook`),
    fields: stringArray(value, "fields", issues, path),
    deps: stringArray(value, "deps", issues, path),
    ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
  };
}

function parseFilter(value: unknown, issues: ManifestIssue[], path: string): FilterManifest {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return { hook: "" };
  }

  return {
    hook: hookName(String(value.hook ?? ""), issues, `${path}.hook`),
    ...(typeof value.priority === "number" ? { priority: value.priority } : {}),
    ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
  };
}

function parseVeto(value: unknown, issues: ManifestIssue[], path: string): VetoManifest {
  const filter = parseFilter(value, issues, path);

  if (!isRecord(value)) {
    return { ...filter, reasonKey: "" };
  }

  const reasonKey = typeof value.reasonKey === "string" ? value.reasonKey : "";

  if (reasonKey === "") {
    issues.push({ path: `${path}.reasonKey`, message: "is required" });
  }

  if (value.failMode !== undefined && value.failMode !== "open" && value.failMode !== "closed") {
    issues.push({ path: `${path}.failMode`, message: "must be open or closed" });
  }

  return {
    ...filter,
    failMode: value.failMode === "closed" ? "closed" : "open",
    reasonKey,
  };
}

function parsePath(value: string): boolean {
  return value !== "" && !value.startsWith("/") && !value.includes("..") && !value.includes("\\");
}

function parseRoute(value: unknown, issues: ManifestIssue[], path: string): RouteManifest {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return { path: "", kind: "page" };
  }

  const routePath = String(value.path ?? "");

  if (!parsePath(routePath)) {
    issues.push({ path: `${path}.path`, message: "must be a relative plugin path" });
  }

  const kind = value.kind === "api" ? "api" : "page";
  return { path: routePath, kind };
}

function parseJob(value: unknown, issues: ManifestIssue[], path: string): JobManifest {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return { name: "" };
  }

  const name = String(value.name ?? "");

  if (!NAME.test(name)) {
    issues.push({ path: `${path}.name`, message: "invalid job name" });
  }

  return {
    name,
    ...(typeof value.schedule === "string" ? { schedule: value.schedule } : {}),
  };
}

function parseClientApp(value: unknown, issues: ManifestIssue[], path: string): ClientAppManifest {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return { name: "", entry: "", hooks: [] };
  }

  const name = String(value.name ?? "");
  const entry = String(value.entry ?? "");

  if (!NAME.test(name)) {
    issues.push({ path: `${path}.name`, message: "invalid client app name" });
  }

  if (entry === "" || !ENTRY.test(entry) || entry.includes("..")) {
    issues.push({ path: `${path}.entry`, message: "must be a relative path inside the bundle" });
  }

  return { name, entry, hooks: stringArray(value, "hooks", issues, path) };
}

function parseI18n(
  value: unknown,
  issues: ManifestIssue[],
  path: string,
): Record<string, Record<string, string>> {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object of locale catalogs" });
    return {};
  }

  const catalogs: Record<string, Record<string, string>> = {};

  for (const [locale, catalog] of Object.entries(value)) {
    if (!isRecord(catalog) || Object.values(catalog).some((entry) => typeof entry !== "string")) {
      issues.push({ path: `${path}.${locale}`, message: "must map keys to strings" });
      continue;
    }

    catalogs[locale] = catalog as Record<string, string>;
  }

  return catalogs;
}

function parsePersonalData(
  value: unknown,
  issues: ManifestIssue[],
  path: string,
): PersonalDataManifest {
  if (
    !isRecord(value) ||
    typeof value.table !== "string" ||
    typeof value.memberColumn !== "string"
  ) {
    issues.push({ path, message: "must declare table and memberColumn" });
    return { table: "", memberColumn: "" };
  }

  return { table: value.table, memberColumn: value.memberColumn };
}

/** Parses and validates a manifest value. Unknown fields are ignored for forwards compatibility. */
export function parsePluginManifest(value: unknown): PluginManifest {
  const issues: ManifestIssue[] = [];

  if (!isRecord(value)) {
    throw new ManifestError([{ path: "$", message: "must be an object" }]);
  }

  const id = stringField(value, "id", issues, "$", PLUGIN_ID);
  const entry = stringField(value, "entry", issues, "$", ENTRY);
  const sdkVersion = stringField(value, "sdkVersion", issues, "$");

  if (sdkVersion !== "" && !/^[\d.^~<>=*xX -]+$/.test(sdkVersion)) {
    issues.push({ path: "$.sdkVersion", message: "is not a semver range" });
  }

  if (entry.includes("..")) {
    issues.push({ path: "$.entry", message: "must stay inside the bundle" });
  }

  const capabilities: PluginCapability[] = [];

  for (const [index, capability] of stringArray(value, "capabilities", issues, "$").entries()) {
    if (!(PLUGIN_CAPABILITIES as readonly string[]).includes(capability)) {
      issues.push({ path: `$.capabilities[${String(index)}]`, message: `unknown: ${capability}` });
      continue;
    }

    capabilities.push(capability as PluginCapability);
  }

  const egressHosts = stringArray(value, "egressHosts", issues, "$").map((host) => {
    const normalized = host.toLowerCase();

    if (normalized !== host || !HOST.test(normalized) || normalized.includes("..")) {
      issues.push({ path: "$.egressHosts", message: `invalid host: ${host}` });
    }

    return normalized;
  });

  const migrations = stringArray(value, "migrations", issues, "$");

  for (const migration of migrations) {
    if (!/^[a-z0-9][a-z0-9/_-]*\.sql$/.test(migration) || migration.includes("..")) {
      issues.push({ path: "$.migrations", message: `invalid migration path: ${migration}` });
    }
  }

  const manifest: PluginManifest = {
    id,
    name: stringField(value, "name", issues, "$"),
    version: stringField(value, "version", issues, "$"),
    sdkVersion,
    entry,
    capabilities,
    egressHosts,
    migrations,
    templateFragments: arrayOf(
      value,
      "templateFragments",
      issues,
      "$",
      parseFragment,
    ) as TemplateFragmentManifest[],
    enrichers: arrayOf(value, "enrichers", issues, "$", parseEnricher) as EnricherManifest[],
    filters: arrayOf(value, "filters", issues, "$", parseFilter) as FilterManifest[],
    vetoes: arrayOf(value, "vetoes", issues, "$", parseVeto) as VetoManifest[],
    events: stringArray(value, "events", issues, "$"),
    contentExtensions: stringArray(value, "contentExtensions", issues, "$"),
    routes: arrayOf(value, "routes", issues, "$", parseRoute) as RouteManifest[],
    jobs: arrayOf(value, "jobs", issues, "$", parseJob) as JobManifest[],
    clientApps: arrayOf(value, "clientApps", issues, "$", parseClientApp) as ClientAppManifest[],
    settings: isRecord(value.settings) ? value.settings : null,
    forumActions: stringArray(value, "forumActions", issues, "$").map((action) =>
      hookName(action, issues, "$.forumActions"),
    ),
    flags: stringArray(value, "flags", issues, "$").map((flag) =>
      hookName(flag, issues, "$.flags"),
    ),
    personalData: arrayOf(
      value,
      "personalData",
      issues,
      "$",
      parsePersonalData,
    ) as PersonalDataManifest[],
    i18n: parseI18n(value.i18n, issues, "$.i18n"),
  };

  if (manifest.name === "") {
    issues.push({ path: "$.name", message: "is required" });
  }

  if (manifest.version !== "" && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    issues.push({ path: "$.version", message: "must be a semantic version" });
  }

  if (manifest.vetoes.length > 0 && !capabilities.includes("veto")) {
    issues.push({ path: "$.capabilities", message: "veto hooks require the veto capability" });
  }

  if (issues.length > 0) {
    throw new ManifestError(issues);
  }

  return manifest;
}

/** Reads `plugin.json` from a bundle directory. */
export async function loadPluginManifest(bundlePath: string): Promise<PluginManifest> {
  const text = await Bun.file(`${bundlePath}/plugin.json`).text();

  try {
    return parsePluginManifest(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ManifestError([{ path: "$", message: `not valid JSON: ${error.message}` }]);
    }

    throw error;
  }
}
