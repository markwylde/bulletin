import { createVersionedCache } from "@bulletin/cache";
import {
  type Catalog,
  catalogMessage,
  formatMessage,
  type Locale,
  type MessageValues,
} from "./catalog.ts";

export function stringOverrideTag(locale: Locale): string {
  return `i18n:${locale}`;
}

/** Supplies the durable tag version and the overrides for one locale. */
export interface StringOverrideSource {
  version(locale: Locale): Promise<string>;
  load(locale: Locale): Promise<Catalog>;
}

export interface StringOverrideLayer {
  overrides(locale: Locale): Promise<Catalog>;
  message(locale: Locale, key: string): Promise<string | undefined>;
  translate(locale: Locale, key: string, values?: MessageValues): Promise<string>;
  invalidate(locale?: Locale): void;
}

/**
 * Layers admin overrides over the shipped catalog. Each lookup checks the `i18n:{locale}` tag
 * version, so a write takes effect on the next render without restarting the process.
 */
export function createStringOverrideLayer(source: StringOverrideSource): StringOverrideLayer {
  const cache = createVersionedCache<Locale, Catalog>(source);

  async function overrides(locale: Locale): Promise<Catalog> {
    return (await cache.get(locale)).value;
  }

  async function message(locale: Locale, key: string): Promise<string | undefined> {
    const catalog = await overrides(locale);
    return catalog[key] ?? catalogMessage(locale, key);
  }

  return {
    overrides,
    message,
    async translate(locale, key, values = {}) {
      const resolved = await message(locale, key);
      return resolved === undefined ? key : formatMessage(locale, resolved, values);
    },
    invalidate(locale) {
      cache.invalidate(locale);
    },
  };
}
