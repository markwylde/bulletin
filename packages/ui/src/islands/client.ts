import { type ComponentType, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import * as v from "valibot";
import { FlagsProvider } from "../flags.tsx";
import {
  editorSchema,
  type IslandPropsSchema,
  languageSwitcherSchema,
  localeSuggestionSchema,
  pluginAppSchema,
  postReputationSchema,
  reactionsSchema,
  spikeCounterSchema,
  themeChooserSchema,
} from "./schemas.ts";

/** The result of validating an island's props in the browser. */
export type IslandPreparation =
  | { readonly ok: true; readonly hydrate: (container: Element) => Promise<void> }
  | { readonly ok: false; readonly reason: string };

export interface ClientIsland {
  /** Validates the props carried in `data-props`; the chunk loads only when they pass. */
  readonly prepare: (input: unknown) => IslandPreparation;
}

function clientFlags(root: ParentNode): Readonly<Record<string, boolean>> {
  const raw = root.querySelector("[data-client-flags]")?.getAttribute("data-client-flags");

  if (raw === null || raw === undefined || raw.trim() === "") {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => entry[1] === true),
    );
  } catch {
    return {};
  }
}

function defineClientIsland<TProps extends object>(
  schema: IslandPropsSchema<TProps>,
  load: () => Promise<ComponentType<TProps>>,
): ClientIsland {
  return {
    prepare(input) {
      const parsed = v.safeParse(schema, input);

      if (!parsed.success) {
        return { ok: false, reason: v.summarize(parsed.issues) };
      }

      return {
        ok: true,
        async hydrate(container) {
          const Component = await load();
          hydrateRoot(
            container,
            createElement(
              FlagsProvider,
              { value: clientFlags(container.ownerDocument) },
              createElement(Component, parsed.output),
            ),
          );
        },
      };
    },
  };
}

/**
 * The client half of the fixed island registry (ADR 0008). Each island imports its component
 * dynamically, so Astro/Vite emits one chunk per island instead of one bundle for all of them.
 */
export const CLIENT_ISLANDS: Readonly<Record<string, ClientIsland>> = {
  SpikeCounter: defineClientIsland(spikeCounterSchema, async () => {
    const module = await import("./SpikeCounter.tsx");
    return module.SpikeCounter;
  }),
  LanguageSwitcher: defineClientIsland(languageSwitcherSchema, async () => {
    const module = await import("./LanguageSwitcher.tsx");
    return module.LanguageSwitcher;
  }),
  LocaleSuggestion: defineClientIsland(localeSuggestionSchema, async () => {
    const module = await import("./LocaleSuggestion.tsx");
    return module.LocaleSuggestion;
  }),
  Editor: defineClientIsland(editorSchema, async () => {
    const module = await import("./Editor.tsx");
    return module.Editor;
  }),
  Reactions: defineClientIsland(reactionsSchema, async () => {
    const module = await import("./Reactions.tsx");
    return module.Reactions;
  }),
  PostReputation: defineClientIsland(postReputationSchema, async () => {
    const module = await import("./PostReputation.tsx");
    return module.PostReputation;
  }),
  ThemeChooser: defineClientIsland(themeChooserSchema, async () => {
    const module = await import("./ThemeChooser.tsx");
    return module.ThemeChooser;
  }),
  PluginApp: defineClientIsland(pluginAppSchema, async () => {
    const module = await import("./PluginApp.tsx");
    return module.PluginApp;
  }),
};
