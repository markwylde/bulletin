import type { IslandDefinition } from "@bulletin/templates";
import { type ComponentType, createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { parseSpikeCounterProps, SpikeCounter } from "./SpikeCounter.tsx";

function defineIsland<P extends object>(
  name: string,
  component: (props: P) => ReactNode,
  parse: (input: unknown) => P | null,
): IslandDefinition {
  const Component = component as ComponentType<P>;

  return {
    parse(input) {
      const props = parse(input);

      return props === null
        ? { ok: false, reason: `${name} props do not match the island schema` }
        : { ok: true, props };
    },
    render(props) {
      // `parse` produced these props, so the registry entry knows their shape.
      return renderToString(createElement(Component, props as unknown as P));
    },
  };
}

/** The server half of the fixed island registry (ADR 0008). */
export const SERVER_ISLANDS: Readonly<Record<string, IslandDefinition>> = {
  SpikeCounter: defineIsland("SpikeCounter", SpikeCounter, parseSpikeCounterProps),
};
