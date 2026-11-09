import { LOG_LEVELS, type LogLevel } from "./log.ts";

export const NODE_ENVS = ["development", "test", "production"] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const SEED_SIZES = ["small", "default", "large"] as const;
export type SeedSize = (typeof SEED_SIZES)[number];

/** Environment variables as a plain record, so tests never have to touch the process env. */
export type Env = Readonly<Record<string, string | undefined>>;

export interface BootstrapAdmin {
  readonly issuer: string;
  readonly sub: string;
}

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly logLevel: LogLevel;
  readonly port: number;
  readonly databaseUrl: string;
  readonly sessionSecret: string;
  readonly seed: number;
  readonly seedSize: SeedSize;
  readonly authIssuer: string;
  readonly authJwksUrl: string;
  readonly authUserClientId: string;
  readonly authStaffClientId: string;
  readonly userOrigin: string;
  readonly staffOrigin: string;
  readonly bootstrapAdmins: readonly BootstrapAdmin[];
}

/**
 * Development-only defaults. Every value here must work without a `.env` file.
 * Secrets in this table are rejected when `NODE_ENV=production` (ADR 0002).
 */
export const DEVELOPMENT_DEFAULTS = {
  PORT: 3000,
  LOG_LEVEL: "info",
  DATABASE_URL: "postgres://bulletin:bulletin@localhost:5432/bulletin",
  SESSION_SECRET: "bulletin-development-only-session-secret",
  SEED: 42,
  SEED_SIZE: "default",
  BULLETIN_AUTH_ISSUER: "http://auth.bulletin.localhost:8080",
  BULLETIN_AUTH_JWKS_URL: "http://auth.bulletin.localhost:8080/.well-known/jwks.json",
  BULLETIN_AUTH_USER_CLIENT_ID: "bulletin-user",
  BULLETIN_AUTH_STAFF_CLIENT_ID: "bulletin-staff",
  BULLETIN_USER_ORIGIN: "http://bulletin.localhost:8080",
  BULLETIN_STAFF_ORIGIN: "http://staff.bulletin.localhost:8080",
} as const;

const PORT_BOUNDS = { min: 1, max: 65_535 } as const;
const SEED_BOUNDS = { min: 0, max: 0xff_ff_ff_ff } as const;
const MIN_PRODUCTION_SECRET_LENGTH = 32;

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

function read(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function parseEnum<T extends string>(
  env: Env,
  key: string,
  allowed: readonly T[],
  fallback: T,
  issues: string[],
): T {
  const raw = read(env, key);

  if (raw === undefined) {
    return fallback;
  }

  if ((allowed as readonly string[]).includes(raw)) {
    return raw as T;
  }

  issues.push(`${key} must be one of: ${allowed.join(", ")}`);
  return fallback;
}

function parseInteger(
  env: Env,
  key: string,
  fallback: number,
  bounds: { readonly min: number; readonly max: number },
  issues: string[],
): number {
  const raw = read(env, key);

  if (raw === undefined) {
    return fallback;
  }

  if (!/^\d+$/.test(raw)) {
    issues.push(`${key} must be an integer between ${bounds.min} and ${bounds.max}`);
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    issues.push(`${key} must be an integer between ${bounds.min} and ${bounds.max}`);
    return fallback;
  }

  return value;
}

function parseProductionValue(
  env: Env,
  key: string,
  devDefault: string,
  nodeEnv: NodeEnv,
  issues: string[],
  minimumLength?: number,
): string {
  const raw = read(env, key);

  if (raw === undefined) {
    if (nodeEnv === "production") {
      issues.push(`${key} must be set in production; the development default is not allowed`);
    }
    return devDefault;
  }

  if (nodeEnv === "production" && raw === devDefault) {
    issues.push(`${key} must not use the development default in production`);
  } else if (
    nodeEnv === "production" &&
    minimumLength !== undefined &&
    raw.length < minimumLength
  ) {
    issues.push(`${key} must be at least ${minimumLength} characters in production`);
  }

  return raw;
}

function parseDatabaseUrl(env: Env, nodeEnv: NodeEnv, issues: string[]): string {
  const value = parseProductionValue(
    env,
    "DATABASE_URL",
    DEVELOPMENT_DEFAULTS.DATABASE_URL,
    nodeEnv,
    issues,
  );

  if (
    value !== DEVELOPMENT_DEFAULTS.DATABASE_URL &&
    !value.startsWith("postgres://") &&
    !value.startsWith("postgresql://")
  ) {
    issues.push("DATABASE_URL must be a postgres:// or postgresql:// URL");
  }

  return value;
}

function parseUrl(env: Env, key: string, fallback: string, issues: string[]): string {
  const raw = (read(env, key) ?? fallback).replace(/\/+$/, "");

  try {
    const url = new URL(raw);

    if (url.origin !== raw || (url.protocol !== "http:" && url.protocol !== "https:")) {
      issues.push(`${key} must be an absolute http(s) origin without a path`);
      return fallback;
    }

    return raw;
  } catch {
    issues.push(`${key} must be an absolute http(s) origin without a path`);
    return fallback;
  }
}

function parseOptionalUrl(env: Env, key: string, fallback: string, issues: string[]): string {
  const raw = (read(env, key) ?? fallback).replace(/\/+$/, "");

  try {
    const url = new URL(raw);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      issues.push(`${key} must be an absolute http(s) URL`);
      return fallback;
    }

    return raw;
  } catch {
    issues.push(`${key} must be an absolute http(s) URL`);
    return fallback;
  }
}

function parseBootstrapAdmins(env: Env, issues: string[]): readonly BootstrapAdmin[] {
  const raw = read(env, "BULLETIN_BOOTSTRAP_ADMINS");

  if (raw === undefined) {
    return [];
  }

  const admins: BootstrapAdmin[] = [];

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();

    if (trimmed === "") {
      continue;
    }

    const separator = trimmed.indexOf("|");
    const issuer = trimmed.slice(0, separator).trim().replace(/\/+$/, "");
    const sub = trimmed.slice(separator + 1).trim();

    if (separator <= 0 || issuer === "" || sub === "") {
      issues.push("BULLETIN_BOOTSTRAP_ADMINS entries must be issuer|sub pairs");
      continue;
    }

    admins.push({ issuer, sub });
  }

  return admins;
}

/**
 * Parses and validates the configuration for one process.
 *
 * Every variable has a working development default; passing an explicit `env` keeps tests
 * hermetic. Invalid configuration throws a `ConfigError` naming each offending variable.
 */
export function loadConfig(env: Env = Bun.env): AppConfig {
  const issues: string[] = [];

  const nodeEnv = parseEnum(env, "NODE_ENV", NODE_ENVS, "development", issues);
  const logLevel = parseEnum<LogLevel>(
    env,
    "LOG_LEVEL",
    LOG_LEVELS,
    DEVELOPMENT_DEFAULTS.LOG_LEVEL,
    issues,
  );
  const port = parseInteger(env, "PORT", DEVELOPMENT_DEFAULTS.PORT, PORT_BOUNDS, issues);
  const seed = parseInteger(env, "SEED", DEVELOPMENT_DEFAULTS.SEED, SEED_BOUNDS, issues);
  const seedSize = parseEnum<SeedSize>(
    env,
    "SEED_SIZE",
    SEED_SIZES,
    DEVELOPMENT_DEFAULTS.SEED_SIZE,
    issues,
  );

  const databaseUrl = parseDatabaseUrl(env, nodeEnv, issues);
  const sessionSecret = parseProductionValue(
    env,
    "SESSION_SECRET",
    DEVELOPMENT_DEFAULTS.SESSION_SECRET,
    nodeEnv,
    issues,
    MIN_PRODUCTION_SECRET_LENGTH,
  );

  const authIssuer = parseUrl(
    env,
    "BULLETIN_AUTH_ISSUER",
    DEVELOPMENT_DEFAULTS.BULLETIN_AUTH_ISSUER,
    issues,
  );
  const authJwksUrl = parseOptionalUrl(
    env,
    "BULLETIN_AUTH_JWKS_URL",
    `${authIssuer}/.well-known/jwks.json`,
    issues,
  );
  const authUserClientId =
    read(env, "BULLETIN_AUTH_USER_CLIENT_ID") ?? DEVELOPMENT_DEFAULTS.BULLETIN_AUTH_USER_CLIENT_ID;
  const authStaffClientId =
    read(env, "BULLETIN_AUTH_STAFF_CLIENT_ID") ??
    DEVELOPMENT_DEFAULTS.BULLETIN_AUTH_STAFF_CLIENT_ID;
  const userOrigin = parseUrl(
    env,
    "BULLETIN_USER_ORIGIN",
    DEVELOPMENT_DEFAULTS.BULLETIN_USER_ORIGIN,
    issues,
  );
  const staffOrigin = parseUrl(
    env,
    "BULLETIN_STAFF_ORIGIN",
    DEVELOPMENT_DEFAULTS.BULLETIN_STAFF_ORIGIN,
    issues,
  );
  const bootstrapAdmins = parseBootstrapAdmins(env, issues);

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return {
    nodeEnv,
    logLevel,
    port,
    databaseUrl,
    sessionSecret,
    seed,
    seedSize,
    authIssuer,
    authJwksUrl,
    authUserClientId,
    authStaffClientId,
    userOrigin,
    staffOrigin,
    bootstrapAdmins,
  };
}
