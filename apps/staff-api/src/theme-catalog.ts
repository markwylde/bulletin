import type { Catalog } from "@bulletin/i18n";

let cached: Promise<Catalog | null> | null = null;

/** The user-app's shipped English catalog, so theme overrides keep known keys and placeholders. */
export function userAppBaseCatalog(): Promise<Catalog | null> {
  cached ??= Bun.file(new URL("../../user-app/i18n/merged/en.json", import.meta.url))
    .json()
    .then((value: unknown) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Catalog)
        : null,
    )
    .catch(() => null);

  return cached;
}
