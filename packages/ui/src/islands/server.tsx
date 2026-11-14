import type { ServerIslandDefinition, ServerIslandRegistry } from "@bulletin/templates";
import { type ComponentType, createElement } from "react";
import { renderToString } from "react-dom/server";
import * as v from "valibot";
import { ApiDocs } from "./ApiDocs.tsx";
import { Editor } from "./Editor.tsx";
import { FeedLinks } from "./FeedLinks.tsx";
import { LanguageSwitcher } from "./LanguageSwitcher.tsx";
import { LocaleSuggestion } from "./LocaleSuggestion.tsx";
import { PluginApp } from "./PluginApp.tsx";
import { PostReputation } from "./PostReputation.tsx";
import { Reactions } from "./Reactions.tsx";
import { SpikeCounter } from "./SpikeCounter.tsx";
import {
  apiDocsSchema,
  editorSchema,
  feedLinksSchema,
  type IslandPropsSchema,
  languageSwitcherSchema,
  localeSuggestionSchema,
  pluginAppSchema,
  postReputationSchema,
  reactionsSchema,
  spikeCounterSchema,
  themeChooserSchema,
} from "./schemas.ts";
import { ThemeChooser } from "./ThemeChooser.tsx";

function defineServerIsland<TProps extends object>(
  name: string,
  schema: IslandPropsSchema<TProps>,
  Component: ComponentType<TProps>,
): ServerIslandDefinition {
  return {
    parse(input) {
      const parsed = v.safeParse(schema, input);

      return parsed.success
        ? { ok: true, props: parsed.output }
        : { ok: false, reason: `${name}: ${v.summarize(parsed.issues)}` };
    },
    render(props) {
      // `parse` produced these props from this schema, so the shape is known.
      return renderToString(createElement(Component, props as unknown as TProps));
    },
  };
}

/** The server half of the fixed island registry (ADR 0008). */
export const SERVER_ISLANDS: ServerIslandRegistry = {
  SpikeCounter: defineServerIsland("SpikeCounter", spikeCounterSchema, SpikeCounter),
  ApiDocs: defineServerIsland("ApiDocs", apiDocsSchema, ApiDocs),
  LanguageSwitcher: defineServerIsland(
    "LanguageSwitcher",
    languageSwitcherSchema,
    LanguageSwitcher,
  ),
  LocaleSuggestion: defineServerIsland(
    "LocaleSuggestion",
    localeSuggestionSchema,
    LocaleSuggestion,
  ),
  Editor: defineServerIsland("Editor", editorSchema, Editor),
  FeedLinks: defineServerIsland("FeedLinks", feedLinksSchema, FeedLinks),
  Reactions: defineServerIsland("Reactions", reactionsSchema, Reactions),
  PostReputation: defineServerIsland("PostReputation", postReputationSchema, PostReputation),
  ThemeChooser: defineServerIsland("ThemeChooser", themeChooserSchema, ThemeChooser),
  PluginApp: defineServerIsland("PluginApp", pluginAppSchema, PluginApp),
};

/**
 * The PluginApp island with the host's configured frame origin (ADR 0018). The origin is
 * injected here, after the template props are read, so neither a theme nor a plugin fragment
 * can point its frame at another origin.
 */
export function pluginAppIsland(origin: string): ServerIslandDefinition {
  const base = SERVER_ISLANDS.PluginApp;

  if (base === undefined) {
    throw new Error("The PluginApp island is not registered");
  }

  return {
    parse(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return base.parse(input);
      }

      return base.parse({ ...input, origin });
    },
    render: base.render,
  };
}
