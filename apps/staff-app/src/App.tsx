import { isStaffScheme } from "@bulletin/domain/permissions";
import type { Locale } from "@bulletin/i18n";
import { I18nProvider } from "@bulletin/ui";
import { ToastProvider } from "@bulletin/ui/feedback";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { BrowserRouter } from "react-router";
import { STAFF_CATALOGS } from "./catalogs.ts";
import { localeFromRequest } from "./locale.ts";
import { SessionProvider, useSession } from "./session.tsx";
import { Shell } from "./shell/Shell.tsx";
import { DeniedPage, ErrorPage, GuestPage, LoadingPage } from "./shell/States.tsx";
import "./styles/index.css";

const SCHEME_STORAGE_KEY = "bulletin_staff_scheme";

function AppRoutes() {
  const { state } = useSession();

  switch (state.status) {
    case "loading":
      return <LoadingPage />;
    case "guest":
      return <GuestPage />;
    case "denied":
      return <DeniedPage />;
    case "error":
      return <ErrorPage />;
    case "authenticated":
      return <Shell />;
  }
}

export function App() {
  const [locale, setLocale] = useState<Locale>(() =>
    localeFromRequest(window.location.search, document.cookie),
  );
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  const onLocale = useCallback((next: Locale) => setLocale(next), []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    const stored = localStorage.getItem(SCHEME_STORAGE_KEY);
    document.documentElement.dataset.scheme = isStaffScheme(stored) ? stored : "system";
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider locale={locale} messages={STAFF_CATALOGS[locale]}>
        <ToastProvider>
          <SessionProvider onLocale={onLocale}>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
          </SessionProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
