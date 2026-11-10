import { CLIENT_ISLANDS } from "@bulletin/ui/islands/client";

/**
 * Spike S1 client runtime: hydrate every `<bl-island>` from the fixed registry (ADR 0008).
 * Task 3.1 replaces this with the registry build, the manifest and the viewport-aware loader.
 */
const PROPS_ATTRIBUTE = "data-props";
const NAME_ATTRIBUTE = "data-name";

function readProps(raw: string | null): unknown {
  if (raw === null) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

for (const island of document.querySelectorAll("bl-island[data-name]")) {
  const name = island.getAttribute(NAME_ATTRIBUTE);
  const hydrate = name === null ? undefined : CLIENT_ISLANDS[name];

  if (hydrate === undefined) {
    console.warn(`[spike-rendering] no client definition for island ${name ?? "(none)"}`);
    continue;
  }

  hydrate(island, readProps(island.getAttribute(PROPS_ATTRIBUTE)));
}
