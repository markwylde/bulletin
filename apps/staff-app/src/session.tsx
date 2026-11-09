import {
  AccessDeniedError,
  type BrowserSessionView,
  beginLogin,
  finishLoginAndRedirect,
  loadSession,
  logout,
} from "@bulletin/domain/auth/browser";
import type { StaffScheme } from "@bulletin/domain/permissions";
import type { Locale } from "@bulletin/i18n";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type SessionState =
  | { readonly status: "loading" }
  | { readonly status: "guest" }
  | { readonly status: "denied" }
  | { readonly status: "error" }
  | { readonly status: "authenticated"; readonly session: BrowserSessionView };

export interface SessionContextValue {
  readonly state: SessionState;
  readonly permissions: readonly string[];
  retry(): void;
  signIn(): void;
  signOut(): Promise<boolean>;
  updateScheme(scheme: StaffScheme): void;
  updateLocale(locale: Locale): void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export interface SessionProviderProps {
  readonly onLocale: (locale: Locale) => void;
  readonly children?: ReactNode;
}

function isCallbackPath(): boolean {
  return window.location.pathname === "/auth/callback";
}

export function SessionProvider({ onLocale, children }: SessionProviderProps) {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const callbackStarted = useRef(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const current = requestId.current + 1;
    requestId.current = current;
    setState({ status: "loading" });

    try {
      const session = await loadSession();

      if (requestId.current !== current) {
        return;
      }

      if (session.authenticated) {
        if (session.locale !== null) {
          onLocale(session.locale);
        }

        setState({ status: "authenticated", session });
        return;
      }

      setState({ status: "guest" });
    } catch (error: unknown) {
      if (requestId.current !== current) {
        return;
      }

      setState(error instanceof AccessDeniedError ? { status: "denied" } : { status: "error" });
    }
  }, [onLocale]);

  useEffect(() => {
    if (isCallbackPath()) {
      if (callbackStarted.current) {
        return;
      }

      callbackStarted.current = true;
      void finishLoginAndRedirect().catch(() => setState({ status: "error" }));
      return;
    }

    void load();

    return () => {
      requestId.current += 1;
    };
  }, [load]);

  const retry = useCallback(() => {
    void load();
  }, [load]);

  const signIn = useCallback(() => {
    void beginLogin().catch(() => setState({ status: "error" }));
  }, []);

  const signOut = useCallback(async () => {
    const ok = await logout();

    if (ok) {
      setState({ status: "guest" });
    }

    return ok;
  }, []);

  const updateScheme = useCallback((scheme: StaffScheme) => {
    setState((current) =>
      current.status === "authenticated"
        ? { status: "authenticated", session: { ...current.session, scheme } }
        : current,
    );
  }, []);

  const updateLocale = useCallback(
    (locale: Locale) => {
      setState((current) =>
        current.status === "authenticated"
          ? { status: "authenticated", session: { ...current.session, locale } }
          : current,
      );
      onLocale(locale);
    },
    [onLocale],
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      state,
      permissions: state.status === "authenticated" ? state.session.permissions : [],
      retry,
      signIn,
      signOut,
      updateScheme,
      updateLocale,
    }),
    [state, retry, signIn, signOut, updateScheme, updateLocale],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);

  if (value === null) {
    throw new Error("useSession must be used within a SessionProvider");
  }

  return value;
}
