import { describe, expect, test } from "bun:test";
import { ConfigError, DEVELOPMENT_DEFAULTS, type Env, loadConfig } from "./env.ts";

function configError(env: Env): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }

  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  test("uses development defaults for every variable", () => {
    const config = loadConfig({});

    expect(config.nodeEnv).toBe("development");
    expect(config.logLevel).toBe(DEVELOPMENT_DEFAULTS.LOG_LEVEL);
    expect(config.port).toBe(DEVELOPMENT_DEFAULTS.PORT);
    expect(config.databaseUrl).toBe(DEVELOPMENT_DEFAULTS.DATABASE_URL);
    expect(config.sessionSecret).toBe(DEVELOPMENT_DEFAULTS.SESSION_SECRET);
    expect(config.seed).toBe(DEVELOPMENT_DEFAULTS.SEED);
    expect(config.seedSize).toBe(DEVELOPMENT_DEFAULTS.SEED_SIZE);
  });

  test("reads explicit values", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "debug",
      PORT: "4321",
      DATABASE_URL: "postgres://bulletin:bulletin@db:5432/bulletin_test",
      SESSION_SECRET: "test-only-secret",
      SEED: "7",
      SEED_SIZE: "large",
    });

    expect(config.nodeEnv).toBe("test");
    expect(config.logLevel).toBe("debug");
    expect(config.port).toBe(4321);
    expect(config.databaseUrl).toBe("postgres://bulletin:bulletin@db:5432/bulletin_test");
    expect(config.sessionSecret).toBe("test-only-secret");
    expect(config.seed).toBe(7);
    expect(config.seedSize).toBe("large");
  });

  test("rejects the development database URL in production", () => {
    const error = configError({
      NODE_ENV: "production",
      DATABASE_URL: DEVELOPMENT_DEFAULTS.DATABASE_URL,
      SESSION_SECRET: "x".repeat(32),
    });

    expect(error.message).toContain("DATABASE_URL");
    expect(error.message).toContain("development default");
  });

  test("rejects the development session secret in production", () => {
    const error = configError({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://bulletin:prod@db:5432/bulletin",
      SESSION_SECRET: DEVELOPMENT_DEFAULTS.SESSION_SECRET,
    });

    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]).toContain("SESSION_SECRET");
    expect(error.message).not.toContain(DEVELOPMENT_DEFAULTS.SESSION_SECRET);
  });

  test("requires secrets to be set explicitly in production", () => {
    const error = configError({ NODE_ENV: "production" });

    expect(error.message).toContain("DATABASE_URL must be set in production");
    expect(error.message).toContain("SESSION_SECRET must be set in production");
  });

  test("accepts explicit production secrets", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://bulletin:prod@db:5432/bulletin",
      SESSION_SECRET: "y".repeat(32),
    });

    expect(config.nodeEnv).toBe("production");
    expect(config.sessionSecret).toBe("y".repeat(32));
  });

  test("rejects a short production session secret", () => {
    const error = configError({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://bulletin:prod@db:5432/bulletin",
      SESSION_SECRET: "too-short",
    });

    expect(error.message).toContain("SESSION_SECRET must be at least 32 characters");
  });

  test("rejects a non-Postgres database URL", () => {
    const error = configError({
      DATABASE_URL: "mysql://bulletin:bulletin@db:3306/bulletin",
    });

    expect(error.message).toContain("DATABASE_URL must be a postgres://");
  });

  test("names every invalid variable", () => {
    const error = configError({
      NODE_ENV: "staging",
      LOG_LEVEL: "verbose",
      PORT: "not-a-port",
      SEED: "1e3",
      SEED_SIZE: "huge",
    });

    expect(error.issues).toHaveLength(5);
    expect(error.message).toContain("NODE_ENV");
    expect(error.message).toContain("LOG_LEVEL");
    expect(error.message).toContain("PORT");
    expect(error.message).toContain("SEED must be an integer");
    expect(error.message).toContain("SEED_SIZE");
  });

  test("treats blank values as unset", () => {
    const config = loadConfig({ PORT: "  ", LOG_LEVEL: "", SEED: "" });

    expect(config.port).toBe(DEVELOPMENT_DEFAULTS.PORT);
    expect(config.logLevel).toBe(DEVELOPMENT_DEFAULTS.LOG_LEVEL);
    expect(config.seed).toBe(DEVELOPMENT_DEFAULTS.SEED);
  });
});
