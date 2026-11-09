import { useT } from "@bulletin/ui";
import { useSession } from "../session.tsx";

export function LoadingPage() {
  const t = useT();

  return (
    <main className="staff-auth-page" data-auth-state="loading">
      <p>{t("auth.signingIn")}</p>
    </main>
  );
}

export function GuestPage() {
  const t = useT();
  const { signIn } = useSession();

  return (
    <main className="staff-auth-page" data-auth-state="guest">
      <h1>{t("staff.login.title")}</h1>
      <p>{t("staff.login.body")}</p>
      <button type="button" data-login onClick={signIn}>
        {t("auth.login")}
      </button>
    </main>
  );
}

export function DeniedPage() {
  const t = useT();
  const { signIn } = useSession();

  return (
    <main className="staff-auth-page" data-auth-state="error" data-access-denied="session">
      <h1>{t("staff.accessDenied.title")}</h1>
      <p>{t("staff.accessDenied.body")}</p>
      <button type="button" data-login onClick={signIn}>
        {t("auth.login")}
      </button>
    </main>
  );
}

export function ErrorPage() {
  const t = useT();
  const { retry, signIn } = useSession();

  return (
    <main className="staff-auth-page" data-auth-state="error">
      <h1>{t("staff.error.title")}</h1>
      <p>{t("staff.error.body")}</p>
      <div className="button-row">
        <button type="button" data-retry onClick={retry}>
          {t("staff.retry")}
        </button>
        <button type="button" data-login onClick={signIn}>
          {t("auth.login")}
        </button>
      </div>
    </main>
  );
}
