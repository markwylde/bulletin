import { describe, expect, test } from "bun:test";

const APP_SERVICES = [
  "user-app",
  "user-api",
  "staff-app",
  "staff-api",
  "workers",
  "plugin-host",
] as const;

const ORIGIN_HOSTS = [
  "bulletin.localhost",
  "staff.bulletin.localhost",
  "files.bulletin.localhost",
  "plugins.bulletin.localhost",
  "auth.bulletin.localhost",
] as const;

const PACKAGE_WORKSPACES = [
  "db",
  "domain",
  "cache",
  "content",
  "templates",
  "plugin-sdk",
  "i18n",
  "flags",
  "storage",
  "ui",
  "config",
  "test-utils",
] as const;

interface ComposeWatch {
  readonly action?: string;
  readonly path?: string;
  readonly target?: string;
}

interface ComposeService {
  readonly build?: { readonly dockerfile?: string; readonly target?: string };
  readonly image?: string;
  readonly ports?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly container_name?: string;
  readonly depends_on?: Readonly<Record<string, { readonly condition?: string }>>;
  readonly develop?: { readonly watch?: readonly ComposeWatch[] };
  readonly cap_add?: readonly string[];
  readonly security_opt?: readonly string[];
  readonly cgroup?: string;
  readonly volumes?: readonly string[];
}

interface ComposeFile {
  readonly name?: string;
  readonly "x-app-environment"?: Readonly<Record<string, string>>;
  readonly services?: Readonly<Record<string, ComposeService>>;
  readonly volumes?: Readonly<Record<string, unknown>>;
}

type Environment = Readonly<Record<string, string | undefined>>;

/** Resolves compose's `${VAR:-default}` syntax for the given environment. */
function interpolate(value: string, env: Environment): string {
  return value.replace(
    /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback: string | undefined) => env[name] ?? fallback ?? "",
  );
}

/** Resolves Caddy's `{$VAR:default}` syntax for the given environment. */
function interpolateCaddy(value: string, env: Environment): string {
  return value.replace(
    /\{\$([A-Z_][A-Z0-9_]*)(?::([^}]*))?\}/g,
    (_match, name: string, fallback: string | undefined) => env[name] ?? fallback ?? "",
  );
}

interface DarkAuthClient {
  readonly id?: string;
}

interface DarkAuthProfile {
  readonly sub?: string;
}

interface DarkAuthConfig {
  readonly clients?: readonly DarkAuthClient[];
  readonly users?: readonly DarkAuthProfile[];
}

const compose = Bun.YAML.parse(
  await Bun.file(new URL("../compose.yaml", import.meta.url)).text(),
) as ComposeFile;

const composeTest = Bun.YAML.parse(
  await Bun.file(new URL("../compose.test.yaml", import.meta.url)).text(),
) as ComposeFile;

const darkAuth = Bun.YAML.parse(
  await Bun.file(new URL("../darkauth-mock.yaml", import.meta.url)).text(),
) as DarkAuthConfig;

describe("compose stack", () => {
  test("every app builds from its own Dockerfile for the dev target", () => {
    for (const name of APP_SERVICES) {
      const service = compose.services?.[name];

      expect(service).toBeDefined();
      expect(service?.build?.dockerfile).toBe(`apps/${name}/Dockerfile`);
      expect(service?.build?.target).toBe("dev");
    }
  });

  test("every app watches source, config and dependency manifests", () => {
    for (const name of APP_SERVICES) {
      const watch = compose.services?.[name]?.develop?.watch ?? [];
      const actions = new Set(watch.map((entry) => entry.action));

      expect(actions.has("sync")).toBe(true);
      expect(actions.has("sync+restart")).toBe(true);
      expect(actions.has("rebuild")).toBe(true);
      expect(watch).toContainEqual({
        action: "sync",
        path: `./apps/${name}/src`,
        target: `/app/apps/${name}/src`,
      });

      for (const packageName of PACKAGE_WORKSPACES) {
        expect(watch).toContainEqual({
          action: "rebuild",
          path: `./packages/${packageName}/package.json`,
        });
      }
    }
  });

  test("every app depends on a healthy Postgres", () => {
    for (const name of APP_SERVICES) {
      expect(compose.services?.[name]?.depends_on?.postgres?.condition).toBe("service_healthy");
    }

    expect(compose.services?.postgres?.image).toMatch(/^postgres:\d+(?:\.\d+){1,2}-alpine$/);
  });

  test("only the Postgres and darkauth-mock data volumes are named", () => {
    expect(Object.keys(compose.volumes ?? {}).sort()).toEqual([
      "darkauth-mock-data",
      "postgres-data",
    ]);
  });

  test("only plugin-host is privileged, with the sandbox capabilities it needs", () => {
    const pluginHost = compose.services?.["plugin-host"];

    expect(pluginHost?.cap_add).toEqual(["SYS_ADMIN"]);
    expect(pluginHost?.security_opt).toEqual(["seccomp=unconfined", "label=disable"]);
    expect(pluginHost?.cgroup).toBe("host");
    expect(pluginHost?.volumes).toContain("/sys/fs/cgroup:/sys/fs/cgroup:rw");

    for (const name of APP_SERVICES.filter((service) => service !== "plugin-host")) {
      expect(compose.services?.[name]?.cap_add).toBeUndefined();
    }
  });

  test("the proxy port follows BULLETIN_HTTP_PORT and defaults to 8080", () => {
    const ports = compose.services?.proxy?.ports ?? [];

    expect(ports).toEqual([`\${BULLETIN_HTTP_PORT:-8080}:\${BULLETIN_HTTP_PORT:-8080}`]);
    expect(ports.map((port) => interpolate(port, {}))).toEqual(["8080:8080"]);
    expect(ports.map((port) => interpolate(port, { BULLETIN_HTTP_PORT: "18080" }))).toEqual([
      "18080:18080",
    ]);
  });

  test("every ADR 0018 Caddy site address follows BULLETIN_HTTP_PORT", async () => {
    const caddyfile = await Bun.file(new URL("../apps/proxy/Caddyfile", import.meta.url)).text();

    for (const host of ORIGIN_HOSTS) {
      const address = `http://${host}:{$BULLETIN_HTTP_PORT:8080}`;
      expect(caddyfile).toContain(address);
      expect(interpolateCaddy(address, {})).toBe(`http://${host}:8080`);
      expect(interpolateCaddy(address, { BULLETIN_HTTP_PORT: "18080" })).toBe(
        `http://${host}:18080`,
      );
    }
  });

  test("the compose project name follows COMPOSE_PROJECT_NAME and defaults to bulletin", () => {
    expect(compose.name).toBe(`\${COMPOSE_PROJECT_NAME:-bulletin}`);
    expect(interpolate(compose.name ?? "", {})).toBe("bulletin");
    expect(interpolate(compose.name ?? "", { COMPOSE_PROJECT_NAME: "bulletin-agent" })).toBe(
      "bulletin-agent",
    );
  });

  test("no service pins a container name, so projects never collide", () => {
    for (const [name, service] of Object.entries(compose.services ?? {})) {
      expect(service.container_name, `${name} sets container_name`).toBeUndefined();
    }
  });

  test("writable data lives in named volumes, so each project gets its own", () => {
    for (const [name, service] of Object.entries(compose.services ?? {})) {
      for (const volume of service.volumes ?? []) {
        const source = volume.split(":")[0] ?? "";
        const isNamedVolume = Object.hasOwn(compose.volumes ?? {}, source);
        const isReadOnlyConfig = source.startsWith("./") && volume.endsWith(":ro");
        const isKernelMount = source.startsWith("/sys/fs/cgroup");

        expect(isNamedVolume || isReadOnlyConfig || isKernelMount, `${name} uses ${volume}`).toBe(
          true,
        );
      }
    }
  });

  test("app origins and bootstrap admins derive from the published port", () => {
    const shared = compose["x-app-environment"] ?? {};
    const env = (port: number): Environment => ({ BULLETIN_HTTP_PORT: String(port) });

    expect(interpolate(shared.BULLETIN_AUTH_ISSUER ?? "", env(18080))).toBe(
      "http://auth.bulletin.localhost:18080",
    );
    expect(interpolate(shared.BULLETIN_USER_ORIGIN ?? "", env(18080))).toBe(
      "http://bulletin.localhost:18080",
    );
    expect(interpolate(shared.BULLETIN_STAFF_ORIGIN ?? "", env(18080))).toBe(
      "http://staff.bulletin.localhost:18080",
    );
    expect(interpolate(shared.BULLETIN_AUTH_ISSUER ?? "", {})).toBe(
      "http://auth.bulletin.localhost:8080",
    );

    for (const name of ["user-api", "staff-api"]) {
      const admins = compose.services?.[name]?.environment?.BULLETIN_BOOTSTRAP_ADMINS ?? "";
      expect(interpolate(admins, env(18080))).toBe("http://auth.bulletin.localhost:18080|admin");
    }
  });

  test("the DarkAuth mock issuer and redirect origins follow the published port", () => {
    const environment = compose.services?.["darkauth-mock"]?.environment ?? {};
    const env: Environment = { BULLETIN_HTTP_PORT: "18080" };

    expect(interpolate(environment.DARKAUTH_MOCK_ISSUER ?? "", env)).toBe(
      "http://auth.bulletin.localhost:18080",
    );
    expect(interpolate(environment.DARKAUTH_MOCK_ALLOWED_ORIGINS ?? "", env).split(",")).toEqual([
      "http://bulletin.localhost:18080",
      "http://staff.bulletin.localhost:18080",
      "http://auth.bulletin.localhost:18080",
    ]);
  });

  test("the test service receives the same port and issuer", () => {
    const environment = composeTest.services?.test?.environment ?? {};

    expect(environment.BULLETIN_HTTP_PORT).toBe(`\${BULLETIN_HTTP_PORT:-8080}`);
    expect(interpolate(environment.BULLETIN_HTTP_PORT ?? "", { BULLETIN_HTTP_PORT: "18080" })).toBe(
      "18080",
    );
    expect(interpolate(environment.BULLETIN_AUTH_ISSUER ?? "", {})).toBe(
      "http://auth.bulletin.localhost:8080",
    );
    expect(
      interpolate(environment.BULLETIN_AUTH_ISSUER ?? "", { BULLETIN_HTTP_PORT: "18080" }),
    ).toBe("http://auth.bulletin.localhost:18080");
  });

  test("the oEmbed mock provider URL follows the published port", () => {
    const origin = compose.services?.oembed?.environment?.BULLETIN_PUBLIC_ORIGIN ?? "";

    expect(interpolate(origin, {})).toBe("http://bulletin.localhost:8080");
    expect(interpolate(origin, { BULLETIN_HTTP_PORT: "18080" })).toBe(
      "http://bulletin.localhost:18080",
    );
  });
});

describe("darkauth-mock config", () => {
  test("declares the user and staff clients", () => {
    expect(darkAuth.clients?.map((client) => client.id)).toEqual([
      "bulletin-user",
      "bulletin-staff",
    ]);
  });

  test("declares a profile for every seeded role", () => {
    expect(darkAuth.users?.map((profile) => profile.sub)).toEqual([
      "admin",
      "super-mod",
      "forum-mod",
      "member-mod",
      "member-1",
      "member-2",
      "new-member",
      "banned-member",
      "warned-member",
      "member-es",
      "member-fr",
    ]);
  });
});
