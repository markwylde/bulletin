import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { parseSpikeCounterProps, SpikeCounter } from "./SpikeCounter.tsx";

/** Hydrates one `<bl-island>` element; props are re-validated in the browser. */
export type IslandHydrator = (container: Element, props: unknown) => void;

export const CLIENT_ISLANDS: Readonly<Record<string, IslandHydrator>> = {
  SpikeCounter(container, props) {
    const parsed = parseSpikeCounterProps(props);

    if (parsed === null) {
      return;
    }

    hydrateRoot(container, createElement(SpikeCounter, parsed));
  },
};
