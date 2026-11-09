/** The port published by the local proxy when `BULLETIN_HTTP_PORT` is unset. */
export const DEFAULT_HTTP_PORT = 8080;

export type StackHost = "user" | "staff" | "files" | "plugins" | "auth";

export type Env = Readonly<Record<string, string | undefined>>;

const STACK_HOSTS: Readonly<Record<StackHost, string>> = {
  user: "bulletin.localhost",
  staff: "staff.bulletin.localhost",
  files: "files.bulletin.localhost",
  plugins: "plugins.bulletin.localhost",
  auth: "auth.bulletin.localhost",
};

function optional(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Reads the published proxy port from the environment. Tests and E2E use this so every
 * checkout can run against its own stack (ADR 0002, ADR 0018).
 */
export function httpPort(env: Env = Bun.env): number {
  const raw = optional(env, "BULLETIN_HTTP_PORT");

  if (raw === undefined) {
    return DEFAULT_HTTP_PORT;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`BULLETIN_HTTP_PORT must be an integer, got ${raw}`);
  }

  const port = Number(raw);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`BULLETIN_HTTP_PORT must be between 1 and 65535, got ${raw}`);
  }

  return port;
}

/** The public origin for one ADR 0018 hostname on the configured port. */
export function stackOrigin(host: StackHost, env: Env = Bun.env): string {
  return `http://${STACK_HOSTS[host]}:${httpPort(env)}`;
}

export function userOrigin(env: Env = Bun.env): string {
  return stackOrigin("user", env);
}

export function staffOrigin(env: Env = Bun.env): string {
  return stackOrigin("staff", env);
}

export function authIssuer(env: Env = Bun.env): string {
  return stackOrigin("auth", env);
}

/** User-app base URL: an explicit `BULLETIN_BASE_URL` wins, otherwise derived from the port. */
export function userBaseUrl(env: Env = Bun.env): string {
  return optional(env, "BULLETIN_BASE_URL") ?? userOrigin(env);
}

/** Staff-app base URL: an explicit override wins, otherwise derived from the port. */
export function staffBaseUrl(env: Env = Bun.env): string {
  return optional(env, "BULLETIN_STAFF_BASE_URL") ?? staffOrigin(env);
}
