/**
 * Island checks for themes and routes (ADR 0008): a theme must place the islands a route
 * declares, and a rendered page must actually contain them.
 */

const RENDERED_ISLAND = /<bl-island\b[^>]*\bdata-name="([^"]+)"/g;
const DECLARED_ISLAND = /\{%-?\s*island\s+["']([^"']+)["']/g;

function unique(matcher: RegExp, source: string): readonly string[] {
  const names: string[] = [];

  for (const match of source.matchAll(matcher)) {
    const name = match[1];

    if (name !== undefined && !names.includes(name)) {
      names.push(name);
    }
  }

  return names;
}

/** Island names present in rendered HTML, in document order. */
export function renderedIslands(html: string): readonly string[] {
  return unique(RENDERED_ISLAND, html);
}

/** Required islands that the rendered page does not contain. */
export function missingRenderedIslands(
  html: string,
  required: readonly string[],
): readonly string[] {
  const present = new Set(renderedIslands(html));

  return required.filter((island) => !present.has(island));
}

/** Literal island names a template places via `{% island "Name" %}`. */
export function declaredIslands(source: string): readonly string[] {
  return unique(DECLARED_ISLAND, source);
}

/** Every literal island a theme declares across its templates. */
export function declaredIslandsIn(templates: Readonly<Record<string, string>>): readonly string[] {
  const names = new Set<string>();

  for (const source of Object.values(templates)) {
    for (const island of declaredIslands(source)) {
      names.add(island);
    }
  }

  return [...names];
}

/** The island names present in one route's page and region templates. */
export function declaredIslandsInComposition(
  templates: Readonly<Record<string, string>>,
  composition: { readonly page: string; readonly regions: readonly string[] },
): readonly string[] {
  const names = new Set<string>();
  const sources = [
    templates[composition.page] ?? "",
    ...composition.regions.map((region) => templates[region] ?? ""),
  ];

  for (const source of sources) {
    for (const island of declaredIslands(source)) {
      names.add(island);
    }
  }

  return [...names];
}

/**
 * Required islands a route's own composition does not declare. Checking the whole theme would
 * hide a missing island behind an unrelated template, so every route checks its page and
 * regions only (ADR 0008). The `themes` change refuses activation with this list.
 */
export function missingCompositionIslands(
  templates: Readonly<Record<string, string>>,
  composition: { readonly page: string; readonly regions: readonly string[] },
  required: readonly string[],
): readonly string[] {
  const declared = new Set(declaredIslandsInComposition(templates, composition));

  return required.filter((island) => !declared.has(island));
}
