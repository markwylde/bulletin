import {
  encodeThemeBundle,
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

export interface CatalogPackage {
  readonly id: string;
  readonly type: "theme" | "plugin";
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly bundleUrl: string;
  readonly signatureUrl: string;
}

export interface MarketplacePackage {
  readonly package: ThemePackage;
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
