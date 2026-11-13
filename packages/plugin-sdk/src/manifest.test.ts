import { describe, expect, test } from "bun:test";
import { ManifestError, parsePluginManifest } from "./manifest.ts";

const BASE = {
  id: "hide-post-count",
  name: "Hide post count",
  version: "1.2.0",
  sdkVersion: "^2.0.0",
  entry: "server.ts",
  egressHosts: ["api.example.com"],
  migrations: ["migrations/0001.sql"],
};

describe("plugin manifest", () => {
  test("parses the minimal demo shape with defaults", () => {
    const manifest = parsePluginManifest(BASE);

    expect(manifest).toMatchObject({
      id: "hide-post-count",
      version: "1.2.0",
      egressHosts: ["api.example.com"],
      capabilities: [],
      templateFragments: [],
      enrichers: [],
      vetoes: [],
      routes: [],
      jobs: [],
      clientApps: [],
      settings: null,
      i18n: {},
    });
  });

  test("parses fragments, hooks, routes, jobs, client apps and GDPR tables", () => {
    const manifest = parsePluginManifest({
      ...BASE,
      capabilities: ["template", "enricher", "filter", "veto", "route", "client", "events"],
      templateFragments: [
        { name: "post.userbar", kind: "override", body: "<span>{{ postCount }}</span>" },
      ],
      enrichers: [{ hook: "topic.view", fields: ["tipTotal"], deps: ["tips"] }],
      filters: [{ hook: "post.write", priority: 10 }],
      vetoes: [{ hook: "post.write", reasonKey: "plugin.spam.reason", failMode: "closed" }],
      events: ["topic.created"],
      contentExtensions: ["tip"],
      routes: [
        { path: "tip/:postId", kind: "page" },
        { path: "tip", kind: "api" },
      ],
      jobs: [{ name: "leaderboard", schedule: "0 * * * *" }],
      clientApps: [{ name: "tip-jar", entry: "client/index.js", hooks: ["post.userbar"] }],
      settings: { sections: [] },
      forumActions: ["can_tip"],
      flags: ["tip_jar"],
      personalData: [{ table: "tips", memberColumn: "member_id" }],
      i18n: { en: { "plugin.tip": "Tip" } },
    });

    expect(manifest.templateFragments[0]).toMatchObject({ name: "post.userbar", kind: "override" });
    expect(manifest.enrichers[0]).toMatchObject({ hook: "topic.view", fields: ["tipTotal"] });
    expect(manifest.vetoes[0]).toMatchObject({
      reasonKey: "plugin.spam.reason",
      failMode: "closed",
    });
    expect(manifest.routes.map((route) => route.kind)).toEqual(["page", "api"]);
    expect(manifest.clientApps[0]?.hooks).toEqual(["post.userbar"]);
    expect(manifest.personalData).toEqual([{ table: "tips", memberColumn: "member_id" }]);
  });

  test("rejects invalid ids, paths, capabilities and egress hosts", () => {
    const capture = (): unknown => {
      try {
        parsePluginManifest({
          ...BASE,
          id: "Bad Id",
          entry: "../server.ts",
          capabilities: ["admin"],
          egressHosts: ["Example.COM"],
          migrations: ["../evil.sql"],
          routes: [{ path: "/absolute" }],
          vetoes: [{ hook: "post.write" }],
        });
      } catch (caught) {
        return caught;
      }

      return undefined;
    };
    const error = capture();

    expect(error).toBeInstanceOf(ManifestError);
    const paths = (error as ManifestError).issues.map((issue) => issue.path);
    expect(paths).toContain("$.id");
    expect(paths).toContain("$.entry");
    expect(paths).toContain("$.capabilities[0]");
    expect(paths).toContain("$.egressHosts");
    expect(paths).toContain("$.migrations");
    expect(paths).toContain("$.routes[0].path");
    expect(paths).toContain("$.vetoes[0].reasonKey");
    expect(paths).toContain("$.capabilities");
  });

  test("requires en and matching placeholders across plugin catalogs", () => {
    expect(() =>
      parsePluginManifest({
        ...BASE,
        i18n: { es: { "plugin.tip": "Propina" } },
      }),
    ).toThrow("an en catalog is required");

    expect(() =>
      parsePluginManifest({
        ...BASE,
        i18n: {
          en: { "plugin.tip": "Tip {name}" },
          fr: { "plugin.tip": "Pourboire" },
        },
      }),
    ).toThrow("same placeholders");
  });

  test("rejects a non-object and invalid JSON errors are wrapped", async () => {
    expect(() => parsePluginManifest([])).toThrow(ManifestError);
  });
});
