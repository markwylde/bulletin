import { LOG_LEVELS, type LogLevel } from "./log.ts";

export const NODE_ENVS = ["development", "test", "production"] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const SEED_SIZES = ["small", "default", "large"] as const;
export type SeedSize = (typeof SEED_SIZES)[number];

/** Environment variables as a plain record, so tests never have to touch the process env. */
export type Env = Readonly<Record<string, string | undefined>>;

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly logLevel: LogLevel;
  readonly port: number;
  readonly databaseUrl: string;
  readonly sessionSecret: string;
  readonly seed: number;
  readonly seedSize: SeedSize;
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
  };
}
