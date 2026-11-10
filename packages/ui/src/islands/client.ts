import { type ComponentType, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import * as v from "valibot";
import {
  type IslandPropsSchema,
  languageSwitcherSchema,
  localeSuggestionSchema,
  spikeCounterSchema,
} from "./schemas.ts";

/** The result of validating an island's props in the browser. */
export type IslandPreparation =
  | { readonly ok: true; readonly hydrate: (container: Element) => Promise<void> }
  | { readonly ok: false; readonly reason: string };

export interface ClientIsland {
  /** Validates the props carried in `data-props`; the chunk loads only when they pass. */
  readonly prepare: (input: unknown) => IslandPreparation;
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
          hydrateRoot(container, createElement(Component, parsed.output));
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
};
