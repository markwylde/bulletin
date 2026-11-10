import type { LoadedTheme, StoredThemeTemplate, ThemeRecord } from "./store.ts";

export interface ThemeChainFixture {
  readonly name: string;
  readonly version?: number;
  readonly templates?: Readonly<Record<string, string>>;
}

/**
 * Builds a `LoadedTheme` from leaf to root without a database. Test-only helper: it keeps the
 * unit tests for inheritance, compile caching and fallback free of SQL.
 */
export function buildTheme(chain: readonly ThemeChainFixture[]): LoadedTheme {
  if (chain.length === 0) {
    throw new Error("A theme chain needs at least the theme itself");
  }

  const records: ThemeRecord[] = chain.map((entry, index) => ({
    id: String(index + 1),
    name: entry.name,
    version: entry.version ?? 1,
    parentId: index + 1 < chain.length ? String(index + 2) : null,
  }));
  const templates = new Map<string, StoredThemeTemplate[]>();

  for (const [index, entry] of chain.entries()) {
    const owner = records[index];

    if (owner === undefined) {
      continue;
    }

    for (const [name, body] of Object.entries(entry.templates ?? {})) {
      const candidates = templates.get(name) ?? [];
      candidates.push({
        themeId: owner.id,
        themeName: owner.name,
        name,
        body,
        version: 1,
      });
      templates.set(name, candidates);
    }
  }

  const theme = records[0];

  if (theme === undefined) {
    throw new Error("A theme chain needs at least the theme itself");
  }

  return { theme, chain: records, templates };
}
