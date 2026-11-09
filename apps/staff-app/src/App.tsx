import {
  beginLogin,
  beginStepUp,
  finishLoginAndRedirect,
  loadSession,
  logout,
} from "@bulletin/domain/auth/browser";
import { I18nProvider, useT } from "@bulletin/ui";
import { useEffect, useState } from "react";
import { STAFF_CATALOGS } from "./catalogs.ts";
import { localeFromRequest } from "./locale.ts";
import "./styles.css";

type AuthState =
  | { readonly status: "loading" }
  | { readonly status: "guest" }
  | { readonly status: "authenticated"; readonly displayName: string | null }
  | { readonly status: "error" };

type SensitiveState = "idle" | "ok" | "error";

const STEP_UP_PENDING_KEY = "bulletin_step_up_pending";

async function runSensitive(setState: (state: SensitiveState) => void): Promise<void> {
  const response = await fetch("/api/test/sensitive", {
    credentials: "include",
    headers: { accept: "application/json" },
  });

  if (response.ok) {
    setState("ok");
    return;
  }

  const body = await response.json().catch(() => null);

  if (
    response.status === 401 &&
    typeof body === "object" &&
    body !== null &&
    (body as Record<string, unknown>).code === "step_up_required"
  ) {
    sessionStorage.setItem(STEP_UP_PENDING_KEY, "1");
    await beginStepUp({ returnTo: "/" });
    return;
  }

  setState("error");
}

function LoginButton({ onError }: { readonly onError: () => void }) {
  const t = useT();

  return (
    <button
      type="button"
      data-login
      onClick={() => {
        void beginLogin().catch(onError);
      }}
    >
      {t("auth.login")}
    </button>
  );
}

function Content() {
  const t = useT();
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [sensitive, setSensitive] = useState<SensitiveState>("idle");

  useEffect(() => {
    if (window.location.pathname === "/auth/callback") {
      void finishLoginAndRedirect().catch(() => setAuth({ status: "error" }));
      return;
    }

    void loadSession()
      .then((session) => {
        setAuth(
          session.authenticated
            ? { status: "authenticated", displayName: session.displayName }
            : { status: "guest" },
        );
      })
      .catch(() => setAuth({ status: "error" }));
  }, []);

  useEffect(() => {
    if (auth.status === "authenticated" && sessionStorage.getItem(STEP_UP_PENDING_KEY) === "1") {
      sessionStorage.removeItem(STEP_UP_PENDING_KEY);
      void runSensitive(setSensitive);
    }
  }, [auth.status]);

  if (auth.status === "loading") {
    return (
      <main data-auth-state="loading">
        <p>{t("auth.signingIn")}</p>
      </main>
    );
  }

  return (
    <main data-auth-state={auth.status}>
      <h1>{t("staff.placeholder.title")}</h1>
      <p>{t("staff.placeholder.body")}</p>
      {auth.status === "authenticated" ? (
        <p data-signed-in>
          {t("auth.signedIn")} {auth.displayName ?? ""}
        </p>
      ) : null}
      {auth.status === "authenticated" ? (
        <button type="button" data-logout onClick={() => void logout()}>
          {t("auth.logout")}
        </button>
      ) : null}
      {auth.status === "authenticated" && import.meta.env.DEV ? (
        <button type="button" data-sensitive onClick={() => void runSensitive(setSensitive)}>
          {t("auth.sensitiveCheck")}
        </button>
      ) : null}
      {sensitive === "ok" ? <p data-sensitive-result="ok">{t("auth.sensitiveOk")}</p> : null}
      {sensitive === "error" ? <p data-sensitive-error>{t("auth.sensitiveError")}</p> : null}
      {auth.status === "guest" || auth.status === "error" ? (
        <LoginButton onError={() => setAuth({ status: "error" })} />
      ) : null}
      {auth.status === "error" ? <p data-auth-error>{t("auth.loginError")}</p> : null}
    </main>
  );
}

export function App() {
  const locale = localeFromRequest(window.location.search, document.cookie);

  return (
    <I18nProvider locale={locale} messages={STAFF_CATALOGS[locale]}>
      <Content />
    </I18nProvider>
  );
}
