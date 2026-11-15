import { useT } from "@bulletin/ui";
import type { ReactNode } from "react";
import { useSession } from "../session.tsx";
import { Button } from "../ui/Button.tsx";

function AuthCard({
  title,
  body,
  children,
}: {
  readonly title: string;
  readonly body: string;
  readonly children?: ReactNode;
}) {
  const t = useT();

  return (
    <div className="auth-card">
      <span className="rail-brand" aria-hidden="true">
        {t("staff.brand").slice(0, 1)}
      </span>
      <h1>{title}</h1>
      <p>{body}</p>
      {children === undefined ? null : <div className="auth-actions">{children}</div>}
    </div>
  );
}

export function LoadingPage() {
  const t = useT();

  return (
    <main className="staff-auth-page" data-auth-state="loading">
      <p className="auth-loading" role="status">
        {t("auth.signingIn")}
      </p>
    </main>
  );
}

export function GuestPage() {
  const t = useT();
  const { signIn } = useSession();

  return (
    <main className="staff-auth-page" data-auth-state="guest">
      <AuthCard title={t("staff.login.title")} body={t("staff.login.body")}>
        <Button variant="primary" data-login onClick={signIn}>
          {t("auth.login")}
        </Button>
      </AuthCard>
    </main>
  );
}

export function DeniedPage() {
  const t = useT();
  const { signIn } = useSession();

  return (
    <main className="staff-auth-page" data-auth-state="error" data-access-denied="session">
      <AuthCard title={t("staff.accessDenied.title")} body={t("staff.accessDenied.body")}>
        <Button data-login onClick={signIn}>
          {t("auth.login")}
        </Button>
      </AuthCard>
    </main>
  );
}

export function ErrorPage() {
  const t = useT();
  const { retry, signIn } = useSession();

  return (
    <main className="staff-auth-page" data-auth-state="error">
      <AuthCard title={t("staff.error.title")} body={t("staff.error.body")}>
        <Button variant="primary" data-retry onClick={retry}>
          {t("staff.retry")}
        </Button>
        <Button data-login onClick={signIn}>
          {t("auth.login")}
        </Button>
      </AuthCard>
    </main>
  );
}
