import { createHash } from "node:crypto";
import { SAMPLE_PLUGINS } from "@bulletin/domain/plugins";
import {
  encodeThemeBundle,
  encodeThemeTar,
  signThemeBundle,
  type ThemeBundleManifest,
} from "@bulletin/domain/themes";
import { loadDefaultThemeTemplates } from "@bulletin/templates";
import { DEV_PRIVATE_KEY } from "./keys.ts";

export interface ThemePackage {
  readonly id: string;
  readonly type: "theme";
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly bundleUrl: string;
  readonly signatureUrl: string;
}

export interface PluginPackage {
  readonly id: string;
  readonly type: "plugin";
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  readonly sdkVersion: string;
  readonly sdkMajor: number;
  readonly capabilities: readonly string[];
  readonly bundleUrl: string;
  readonly signatureUrl: string;
  readonly sha256: string;
}

export interface CatalogPackage {
  readonly id: string;
  readonly type: "theme" | "plugin";
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly bundleUrl: string;
  readonly signatureUrl: string;
  readonly author?: string;
  readonly sdkVersion?: string;
  readonly sdkMajor?: number;
  readonly capabilities?: readonly string[];
  readonly sha256?: string;
}

export interface MarketplacePackage {
  readonly package: ThemePackage | PluginPackage;
  readonly bundle: Uint8Array;
  readonly signature: string;
}

function manifest(
  name: string,
  description: string,
  templates: Readonly<Record<string, string>>,
  accent: { readonly light: string; readonly dark: string },
): ThemeBundleManifest {
  return {
    format: "bulletin-theme",
    formatVersion: 1,
    name,
    parent: "default",
    description,
    version: 1,
    templates,
    tokens: { light: { accent: accent.light }, dark: { accent: accent.dark } },
    css: ".bl-header { border-block-end-width: 3px; }",
    strings: [{ locale: "en", key: "theme.footer", value: `${name} community` }],
    assets: [],
  };
}

/** Builds the marketplace's signed theme packages at process start. */
export async function buildThemePackages(): Promise<readonly MarketplacePackage[]> {
  const templates = await loadDefaultThemeTemplates();
  const topic = templates.topic ?? "";
  const footer = templates.footer ?? "";

  const valid = manifest(
    "aurora",
    "A soft aurora palette that extends the default theme.",
    {
      footer: footer.replace(
        "<span data-board-year>{{ year }}</span>",
        "<span data-board-year>{{ year }}</span> <span data-theme-credit>aurora</span>",
      ),
    },
    { light: "#3b4fbf", dark: "#9ab0ff" },
  );
  const broken = manifest(
    "broken-island",
    "A package whose topic template omits the reply editor.",
    { topic: topic.replace(/\{%-?\s*island\s+"Editor"[^%]*%\}/g, "") },
    { light: "#b45309", dark: "#f0a35e" },
  );

  return Promise.all(
    [valid, broken].map(async (theme) => {
      const bundle = encodeThemeBundle(theme, new Map());
      const signature = signThemeBundle(bundle, DEV_PRIVATE_KEY);

      return {
        package: {
          id: theme.name,
          type: "theme" as const,
          name: theme.name,
          version: "1.0.0",
          description: theme.description,
          bundleUrl: `/packages/${theme.name}.tar`,
          signatureUrl: `/packages/${theme.name}.sig`,
        },
        bundle,
        signature,
      };
    }),
  );
}

/** Builds every sample plugin bundle from `mocks/marketplace/plugins/<id>`. */
export async function buildPluginPackages(): Promise<readonly MarketplacePackage[]> {
  const root = new URL("../plugins/", import.meta.url);
  const results: MarketplacePackage[] = [];

  for (const plugin of SAMPLE_PLUGINS) {
    const directory = new URL(`${plugin.id}/`, root);
    const entries: Array<{ readonly name: string; readonly data: Uint8Array }> = [];

    for await (const path of new Bun.Glob("**/*").scan({
      cwd: Bun.fileURLToPath(directory),
      onlyFiles: true,
    })) {
      entries.push({
        name: path,
        data: new Uint8Array(await Bun.file(new URL(path, directory)).arrayBuffer()),
      });
    }

    // A published bundle is self-contained: the jail has no node_modules, so the SDK is
    // compiled into the entry the way a plugin author's build step would (ADR 0009).
    const manifest = (await Bun.file(new URL("plugin.json", directory)).json()) as {
      entry: string;
    };
    const built = await Bun.build({
      entrypoints: [Bun.fileURLToPath(new URL(manifest.entry, directory))],
      target: "bun",
      format: "esm",
    });
    const output = built.outputs[0];

    if (!built.success || output === undefined) {
      throw new Error(`Could not build the ${plugin.id} sample plugin`);
    }

    const compiled = new Uint8Array(await output.arrayBuffer());
    const bundleEntries = entries.map((entry) =>
      entry.name === manifest.entry ? { name: entry.name, data: compiled } : entry,
    );

    bundleEntries.sort((left, right) => left.name.localeCompare(right.name));
    const bundle = encodeThemeTar(bundleEntries);
    const signature = signThemeBundle(bundle, DEV_PRIVATE_KEY);
    const sha256 = createHash("sha256").update(bundle).digest("hex");

    results.push({
      package: {
        id: plugin.id,
        type: "plugin",
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        author: plugin.author,
        sdkVersion: plugin.sdkVersion,
        sdkMajor: Number(/(\d+)/.exec(plugin.sdkVersion)?.[1] ?? "0"),
        capabilities: plugin.capabilities,
        bundleUrl: `/packages/${plugin.id}.tar`,
        signatureUrl: `/packages/${plugin.id}.sig`,
        sha256,
      },
      bundle,
      signature,
    });
  }

  return results;
}
