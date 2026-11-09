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
  readonly depends_on?: Readonly<Record<string, { readonly condition?: string }>>;
  readonly develop?: { readonly watch?: readonly ComposeWatch[] };
  readonly cap_add?: readonly string[];
  readonly security_opt?: readonly string[];
  readonly cgroup?: string;
  readonly volumes?: readonly string[];
}

interface ComposeFile {
  readonly services?: Readonly<Record<string, ComposeService>>;
  readonly volumes?: Readonly<Record<string, unknown>>;
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

  test("the proxy publishes 8080 for every ADR 0018 hostname", async () => {
    expect(compose.services?.proxy?.ports).toEqual(["8080:8080"]);

    const caddyfile = await Bun.file(new URL("../apps/proxy/Caddyfile", import.meta.url)).text();

    for (const host of ORIGIN_HOSTS) {
      expect(caddyfile).toContain(`http://${host}:8080`);
    }
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
