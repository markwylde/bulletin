import { type Catalog, createServerT, type Locale, type Translator } from "@bulletin/i18n";
import { createContext, type ReactNode, useContext, useMemo } from "react";

export interface I18nContextValue {
  readonly locale: Locale;
  readonly t: Translator;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export interface I18nProviderProps {
  readonly locale: Locale;
  /** Runtime messages for this island, layered over the shipped catalogs. */
  readonly messages?: Catalog;
  readonly children?: ReactNode;
}

export function I18nProvider({ locale, messages, children }: I18nProviderProps) {
  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      t: createServerT(locale, messages === undefined ? {} : { overrides: messages }),
    }),
    [locale, messages],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18nContext(): I18nContextValue {
  const value = useContext(I18nContext);

  if (value === null) {
    throw new Error("useT must be used within an I18nProvider");
  }

  return value;
}

export function useT(): Translator {
  return useI18nContext().t;
}

export function useLocale(): Locale {
  return useI18nContext().locale;
}
