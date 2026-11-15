import { describe, expect, test } from "bun:test";
import { ConfigError, DEVELOPMENT_DEFAULTS, type Env, loadConfig, parseSeedDemo } from "./env.ts";

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
    expect(config.authIssuer).toBe(DEVELOPMENT_DEFAULTS.BULLETIN_AUTH_ISSUER);
    expect(config.authJwksUrl).toBe(DEVELOPMENT_DEFAULTS.BULLETIN_AUTH_JWKS_URL);
    expect(config.authTokenUrl).toBe(DEVELOPMENT_DEFAULTS.BULLETIN_AUTH_TOKEN_URL);
    expect(config.authUserClientId).toBe(DEVELOPMENT_DEFAULTS.BULLETIN_AUTH_USER_CLIENT_ID);
    expect(config.authStaffClientId).toBe(DEVELOPMENT_DEFAULTS.BULLETIN_AUTH_STAFF_CLIENT_ID);
    expect(config.userOrigin).toBe(DEVELOPMENT_DEFAULTS.BULLETIN_USER_ORIGIN);
    expect(config.staffOrigin).toBe(DEVELOPMENT_DEFAULTS.BULLETIN_STAFF_ORIGIN);
    expect(config.bootstrapAdmins).toEqual([]);
  });

  test("derives local origins from BULLETIN_HTTP_PORT", () => {
    const config = loadConfig({ BULLETIN_HTTP_PORT: "18080" });

    expect(config.authIssuer).toBe("http://auth.bulletin.localhost:18080");
    expect(config.authJwksUrl).toBe("http://auth.bulletin.localhost:18080/.well-known/jwks.json");
    expect(config.authTokenUrl).toBe("http://auth.bulletin.localhost:18080/token");
    expect(config.userOrigin).toBe("http://bulletin.localhost:18080");
    expect(config.staffOrigin).toBe("http://staff.bulletin.localhost:18080");
  });

  test("lets explicit origins override BULLETIN_HTTP_PORT", () => {
    const config = loadConfig({
      BULLETIN_HTTP_PORT: "18080",
      BULLETIN_AUTH_ISSUER: "https://auth.example.test",
      BULLETIN_USER_ORIGIN: "https://forum.example.test",
      BULLETIN_STAFF_ORIGIN: "https://staff.example.test",
    });

    expect(config.authIssuer).toBe("https://auth.example.test");
    expect(config.userOrigin).toBe("https://forum.example.test");
    expect(config.staffOrigin).toBe("https://staff.example.test");
  });

  test("rejects a malformed BULLETIN_HTTP_PORT", () => {
    const error = configError({ BULLETIN_HTTP_PORT: "not-a-port" });

    expect(error.message).toContain("BULLETIN_HTTP_PORT");
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

  test("reads explicit auth values and bootstrap admins", () => {
    const config = loadConfig({
      BULLETIN_AUTH_ISSUER: "https://auth.example.test/",
      BULLETIN_AUTH_USER_CLIENT_ID: "forum-user",
      BULLETIN_AUTH_STAFF_CLIENT_ID: "forum-staff",
      BULLETIN_USER_ORIGIN: "https://forum.example.test",
      BULLETIN_STAFF_ORIGIN: "https://staff.example.test",
      BULLETIN_BOOTSTRAP_ADMINS: "https://auth.example.test|admin, https://auth.example.test|owner",
    });

    expect(config.authIssuer).toBe("https://auth.example.test");
    expect(config.authJwksUrl).toBe("https://auth.example.test/.well-known/jwks.json");
    expect(config.authTokenUrl).toBe("https://auth.example.test/token");
    expect(config.authUserClientId).toBe("forum-user");
    expect(config.authStaffClientId).toBe("forum-staff");
    expect(config.userOrigin).toBe("https://forum.example.test");
    expect(config.staffOrigin).toBe("https://staff.example.test");
    expect(config.bootstrapAdmins).toEqual([
      { issuer: "https://auth.example.test", sub: "admin" },
      { issuer: "https://auth.example.test", sub: "owner" },
    ]);
  });

  test("rejects malformed auth origins and bootstrap entries", () => {
    const error = configError({
      BULLETIN_AUTH_ISSUER: "/relative",
      BULLETIN_USER_ORIGIN: "https://forum.example.test/path",
      BULLETIN_BOOTSTRAP_ADMINS: "not-a-pair, https://auth.example.test|",
    });

    expect(error.message).toContain("BULLETIN_AUTH_ISSUER");
    expect(error.message).toContain("BULLETIN_USER_ORIGIN");
    expect(error.message).toContain("BULLETIN_BOOTSTRAP_ADMINS");
  });

  test("preserves bootstrap issuer and subject exactly", () => {
    const config = loadConfig({
      BULLETIN_BOOTSTRAP_ADMINS:
        "https://auth.example.test/|owner, https://auth.example.test|admin",
    });

    expect(config.bootstrapAdmins).toEqual([
      { issuer: "https://auth.example.test/", sub: "owner" },
      { issuer: "https://auth.example.test", sub: "admin" },
    ]);
  });

  test("rejects whitespace-padded bootstrap issuers and subjects instead of trimming them", () => {
    const error = configError({
      BULLETIN_BOOTSTRAP_ADMINS:
        "https://auth.example.test| admin, https://auth.example.test |owner",
    });

    expect(
      error.issues.filter((issue) => issue.includes("BULLETIN_BOOTSTRAP_ADMINS")),
    ).toHaveLength(2);
  });

  test("rejects the development database URL in production", () => {
    const error = configError({
      NODE_ENV: "production",
      DATABASE_URL: DEVELOPMENT_DEFAULTS.DATABASE_URL,
      SESSION_SECRET: "x".repeat(32),
      BULLETIN_SMTP_URL: "smtp://mail:1025",
      BULLETIN_MAIL_FROM: "Bulletin <no-reply@example.com>",
    });

    expect(error.message).toContain("DATABASE_URL");
    expect(error.message).toContain("development default");
  });

  test("rejects the development session secret in production", () => {
    const error = configError({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://bulletin:prod@db:5432/bulletin",
      SESSION_SECRET: DEVELOPMENT_DEFAULTS.SESSION_SECRET,
      BULLETIN_SMTP_URL: "smtp://mail:1025",
      BULLETIN_MAIL_FROM: "Bulletin <no-reply@example.com>",
    });

    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]).toContain("SESSION_SECRET");
    expect(error.message).not.toContain(DEVELOPMENT_DEFAULTS.SESSION_SECRET);
  });

  test("requires secrets to be set explicitly in production", () => {
    const error = configError({ NODE_ENV: "production" });

    expect(error.message).toContain("DATABASE_URL must be set in production");
    expect(error.message).toContain("SESSION_SECRET must be set in production");
    expect(error.message).toContain("BULLETIN_SMTP_URL must be set in production");
    expect(error.message).toContain("BULLETIN_MAIL_FROM must be set in production");
  });

  test("accepts explicit production secrets", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://bulletin:prod@db:5432/bulletin",
      SESSION_SECRET: "y".repeat(32),
      BULLETIN_SMTP_URL: "smtp://mail:1025",
      BULLETIN_MAIL_FROM: "Bulletin <no-reply@example.com>",
    });

    expect(config.nodeEnv).toBe("production");
    expect(config.sessionSecret).toBe("y".repeat(32));
  });

  test("rejects a short production session secret", () => {
    const error = configError({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://bulletin:prod@db:5432/bulletin",
      SESSION_SECRET: "too-short",
      BULLETIN_SMTP_URL: "smtp://mail:1025",
      BULLETIN_MAIL_FROM: "Bulletin <no-reply@example.com>",
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

describe("parseSeedDemo", () => {
  const run = (env: Env, nodeEnv: "development" | "test" | "production") => {
    const issues: string[] = [];
    const value = parseSeedDemo(env, nodeEnv, issues);
    return { value, issues };
  };

  test("defaults on in development and test, off in production", () => {
    expect(run({}, "development")).toEqual({ value: true, issues: [] });
    expect(run({}, "test")).toEqual({ value: true, issues: [] });
    expect(run({}, "production")).toEqual({ value: false, issues: [] });
    expect(loadConfig({}).seedDemo).toBe(true);
  });

  test("honours an explicit opt-out in development", () => {
    expect(run({ BULLETIN_SEED_DEMO: "false" }, "development")).toEqual({
      value: false,
      issues: [],
    });
    expect(run({ BULLETIN_SEED_DEMO: "0" }, "test").value).toBe(false);
  });

  test("refuses to seed demo data in production even when asked", () => {
    expect(run({ BULLETIN_SEED_DEMO: "true" }, "production")).toEqual({
      value: false,
      issues: ["BULLETIN_SEED_DEMO cannot be enabled in production"],
    });
    expect(run({ BULLETIN_SEED_DEMO: "false" }, "production")).toEqual({
      value: false,
      issues: [],
    });
  });

  test("rejects values that are not booleans", () => {
    expect(run({ BULLETIN_SEED_DEMO: "yes please" }, "development").issues).toEqual([
      "BULLETIN_SEED_DEMO must be true or false",
    ]);
  });
});
