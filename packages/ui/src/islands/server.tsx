import type { ServerIslandDefinition, ServerIslandRegistry } from "@bulletin/templates";
import { type ComponentType, createElement } from "react";
import { renderToString } from "react-dom/server";
import * as v from "valibot";
import { SpikeCounter } from "./SpikeCounter.tsx";
import { type IslandPropsSchema, spikeCounterSchema } from "./schemas.ts";

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
};
