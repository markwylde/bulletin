import { createContext, type ReactNode, useContext } from "react";

/**
 * Only flags marked `clientVisible` belong in this context (ADR 0010). The provider is fed
 * from page data or the personal overlay; it never receives server-only flags.
 */
const FlagsContext = createContext<Readonly<Record<string, boolean>> | null>(null);

export interface FlagsProviderProps {
  readonly value: Readonly<Record<string, boolean>>;
  readonly children?: ReactNode;
}

export function FlagsProvider({ value, children }: FlagsProviderProps) {
  return <FlagsContext.Provider value={value}>{children}</FlagsContext.Provider>;
}

/** Reads a client-visible flag; without a provider, or for an unknown key, it fails closed. */
export function useFlag(key: string): boolean {
  const flags = useContext(FlagsContext);

  // Only an own entry that is exactly `true` enables UI: `{}` must not answer `constructor`.
  return flags !== null && Object.hasOwn(flags, key) && flags[key] === true;
}
