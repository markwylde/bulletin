/** Semantic version helpers for the versioned plugin SDK (ADR 0009). */

export const SDK_VERSION = "2.0.0";
export const SDK_MAJOR = 2;
/** The one previous major that keeps working through compatibility shims. */
export const SHIM_MAJOR = 1;

export interface SdkVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(value: string): SdkVersion | undefined {
  const match = VERSION.exec(value.trim());

  if (match === null) {
    return undefined;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return undefined;
  }

  return { major, minor, patch };
}

export function formatVersion(version: SdkVersion): string {
  return `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
}

function compare(left: SdkVersion, right: SdkVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

type Comparator = (version: SdkVersion) => boolean;

const PARTIAL = /^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/;

function parsePartial(raw: string): { major?: number; minor?: number; patch?: number } | undefined {
  const match = PARTIAL.exec(raw);

  if (match === null) {
    return undefined;
  }

  const parse = (value: string | undefined): number | undefined =>
    value === undefined || /^[xX*]$/.test(value) ? undefined : Number(value);

  const major = parse(match[1]);
  const minor = parse(match[2]);
  const patch = parse(match[3]);
  const result: { major?: number; minor?: number; patch?: number } = {};

  if (major !== undefined) {
    result.major = major;
  }

  if (minor !== undefined) {
    result.minor = minor;
  }

  if (patch !== undefined) {
    result.patch = patch;
  }

  return result;
}

function comparatorFor(token: string): Comparator | undefined {
  const trimmed = token.trim();

  if (trimmed === "" || trimmed === "*" || trimmed === "x" || trimmed === "X") {
    return () => true;
  }

  const operator = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(trimmed);

  if (operator === null) {
    return undefined;
  }

  const op = operator[1] ?? "=";
  const raw = operator[2] ?? "";
  const partial = parsePartial(raw);

  if (partial === undefined || partial.major === undefined) {
    return undefined;
  }

  const lower: SdkVersion = {
    major: partial.major,
    minor: partial.minor ?? 0,
    patch: partial.patch ?? 0,
  };

  switch (op) {
    case "^": {
      const upper: SdkVersion =
        lower.major > 0
          ? { major: lower.major + 1, minor: 0, patch: 0 }
          : { major: 0, minor: lower.minor + 1, patch: 0 };
      return (version) => compare(version, lower) >= 0 && compare(version, upper) < 0;
    }
    case "~": {
      const upper: SdkVersion = { major: lower.major, minor: lower.minor + 1, patch: 0 };
      return (version) =>
        compare(version, lower) >= 0 &&
        (partial.patch === undefined ? compare(version, upper) < 0 : compare(version, upper) < 0);
    }
    case ">=":
      return (version) => compare(version, lower) >= 0;
    case "<=":
      return (version) => compare(version, lower) <= 0;
    case ">":
      return (version) => compare(version, lower) > 0;
    case "<":
      return (version) => compare(version, lower) < 0;
    default:
      if (partial.minor === undefined) {
        return (version) => version.major === lower.major;
      }

      if (partial.patch === undefined) {
        return (version) => version.major === lower.major && version.minor === lower.minor;
      }

      return (version) => compare(version, lower) === 0;
  }
}

/**
 * A small semver-range check for the subset plugin manifests use: exact versions, `^`, `~`,
 * comparison operators, partials (`1.x`), `*` and `||` alternatives.
 */
export function satisfiesSdkRange(range: string, version: string): boolean {
  const parsed = parseVersion(version);

  if (parsed === undefined) {
    return false;
  }

  const alternatives = range.split("||");

  return alternatives.some((alternative) =>
    alternative
      .trim()
      .split(/\s+/)
      .filter((token) => token !== "")
      .map(comparatorFor)
      .every((comparator) => comparator?.(parsed) === true),
  );
}

export interface SdkCompatibility {
  readonly compatible: boolean;
  /** True when the plugin can run only through a previous-major shim. */
  readonly deprecated: boolean;
  /** The major the shim adapts, if any. */
  readonly shimMajor: number | null;
}

export function sdkCompatibility(range: string, hostVersion = SDK_VERSION): SdkCompatibility {
  const host = parseVersion(hostVersion);

  if (host === undefined) {
    return { compatible: false, deprecated: false, shimMajor: null };
  }

  if (satisfiesSdkRange(range, hostVersion)) {
    return { compatible: true, deprecated: false, shimMajor: null };
  }

  if (
    host.major === SDK_MAJOR &&
    satisfiesSdkRange(range, formatVersion({ major: SHIM_MAJOR, minor: 0, patch: 0 }))
  ) {
    return { compatible: true, deprecated: true, shimMajor: SHIM_MAJOR };
  }

  return { compatible: false, deprecated: false, shimMajor: null };
}

/** v1 hook names renamed for v2. The shim keeps plugins on the previous major working. */
const V1_HOOK_SHIMS: Readonly<Record<string, string>> = {
  "post.enrich": "post.view.enrich",
  "post.filter": "post.write.filter",
  "post.veto": "post.write.veto",
  "post.render": "post.content.extend",
};

export function shimHookName(name: string, shimMajor: number): string {
  if (shimMajor !== SHIM_MAJOR) {
    return name;
  }

  return V1_HOOK_SHIMS[name] ?? name;
}
