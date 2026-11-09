export interface MockUser {
  readonly sub: string;
  readonly email: string;
  readonly name: string;
}

export interface MockClient {
  readonly id: string;
  readonly scopes?: readonly string[];
}

export interface MockConfig {
  readonly issuer: string;
  readonly port: number;
  readonly host: string;
  readonly appName: string;
  readonly allowedOrigins: readonly string[];
  readonly clients: readonly MockClient[];
  readonly users: readonly MockUser[];
}

interface RawConfig {
  readonly server?: {
    readonly host?: unknown;
    readonly port?: unknown;
    readonly issuer?: unknown;
    readonly allowedOrigins?: unknown;
  };
  readonly app?: { readonly name?: unknown };
  readonly clients?: readonly {
    readonly id?: unknown;
    readonly scopes?: unknown;
  }[];
  readonly users?: readonly {
    readonly sub?: unknown;
    readonly email?: unknown;
    readonly name?: unknown;
  }[];
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export async function loadConfig(path: string): Promise<MockConfig> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    throw new Error(`DarkAuth mock config not found: ${path}`);
  }

  const raw = Bun.YAML.parse(await file.text()) as RawConfig;
  const server = raw.server ?? {};
  const issuer = (string(server.issuer) ?? "http://auth.bulletin.localhost:8080").replace(
    /\/+$/,
    "",
  );
  const clients: MockClient[] = [];

  for (const client of raw.clients ?? []) {
    const id = string(client.id);

    if (id !== null) {
      clients.push({
        id,
        ...(client.scopes === undefined ? {} : { scopes: stringList(client.scopes) }),
      });
    }
  }

  const users: MockUser[] = [];

  for (const user of raw.users ?? []) {
    const sub = string(user.sub);
    const email = string(user.email);
    const name = string(user.name);

    if (sub !== null && email !== null && name !== null) {
      users.push({ sub, email, name });
    }
  }

  if (clients.length === 0 || users.length === 0) {
    throw new Error("DarkAuth mock config needs at least one client and one user");
  }

  return {
    issuer,
    port: typeof server.port === "number" ? server.port : 3020,
    host: string(server.host) ?? "0.0.0.0",
    appName: string(raw.app?.name) ?? "Bulletin",
    allowedOrigins: stringList(server.allowedOrigins),
    clients,
    users,
  };
}
