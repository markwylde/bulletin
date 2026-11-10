import { CLIENT_ISLANDS } from "./client.ts";

const NAME_ATTRIBUTE = "data-name";
const PROPS_ATTRIBUTE = "data-props";
const HYDRATED_ATTRIBUTE = "data-hydrated";
const FAILED_ATTRIBUTE = "data-hydrate-error";

/** Islands hydrate this far outside the viewport, so scrolling feels instant. */
const PRELOAD_MARGIN = "200px 0px";

export type IslandReporter = (message: string) => void;

export interface HydrateIslandsOptions {
  readonly root?: ParentNode;
  readonly report?: IslandReporter;
  /** Skip viewport deferral; used by tests and pages that need immediate interactivity. */
  readonly immediate?: boolean;
}

export type IslandPropsRead =
  | { readonly ok: true; readonly props: unknown }
  | { readonly ok: false; readonly reason: string };

/** Parses the `data-props` attribute emitted by `{% island %}`. */
export function readIslandProps(raw: string | null): IslandPropsRead {
  if (raw === null || raw.trim() === "") {
    return { ok: true, props: {} };
  }

  try {
    return { ok: true, props: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, reason: "data-props is not valid JSON" };
  }
}

function defaultReport(message: string): void {
  console.warn(`[islands] ${message}`);
}

function mark(element: Element, attribute: string, value: string): void {
  element.setAttribute(attribute, value);
}

/**
 * Hydrates every `<bl-island>` on the page from the fixed registry (ADR 0008). Islands below
 * the fold wait for an intersection within the preload margin; an island that fails to
 * validate or hydrate is reported and left as its server HTML.
 */
export function hydrateIslands(options: HydrateIslandsOptions = {}): void {
  const root = options.root ?? document;
  const report = options.report ?? defaultReport;
  const hydrate = async (element: Element): Promise<void> => {
    const name = element.getAttribute(NAME_ATTRIBUTE) ?? "";
    const definition = CLIENT_ISLANDS[name];

    if (definition === undefined) {
      report(`no client definition for island "${name}"`);
      mark(element, FAILED_ATTRIBUTE, "unknown");
      return;
    }

    const props = readIslandProps(element.getAttribute(PROPS_ATTRIBUTE));

    if (!props.ok) {
      report(`island "${name}" has unreadable props: ${props.reason}`);
      mark(element, FAILED_ATTRIBUTE, "props");
      return;
    }

    const prepared = definition.prepare(props.props);

    if (!prepared.ok) {
      report(`island "${name}" rejected its props: ${prepared.reason}`);
      mark(element, FAILED_ATTRIBUTE, "props");
      return;
    }

    try {
      await prepared.hydrate(element);
      mark(element, HYDRATED_ATTRIBUTE, "true");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      report(`island "${name}" failed to hydrate: ${detail}`);
      mark(element, FAILED_ATTRIBUTE, "hydrate");
    }
  };
  const pending = [...root.querySelectorAll("bl-island[data-name]")].filter(
    (island) => !island.hasAttribute(HYDRATED_ATTRIBUTE) && !island.hasAttribute(FAILED_ATTRIBUTE),
  );

  if (options.immediate === true || typeof IntersectionObserver !== "function") {
    for (const island of pending) {
      void hydrate(island);
    }

    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }

        observer.unobserve(entry.target);
        void hydrate(entry.target);
      }
    },
    { rootMargin: PRELOAD_MARGIN },
  );

  for (const island of pending) {
    observer.observe(island);
  }
}
