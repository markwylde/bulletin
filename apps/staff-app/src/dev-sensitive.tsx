import { beginStepUp } from "@bulletin/domain/auth/browser";
import { useT } from "@bulletin/ui";
import { useEffect, useRef, useState } from "react";

const STEP_UP_PENDING_KEY = "bulletin_step_up_pending";

type SensitiveState = "idle" | "ok" | "error";

async function runSensitive(setState: (state: SensitiveState) => void): Promise<void> {
  const response = await fetch("/api/test/sensitive", {
    credentials: "include",
    headers: { accept: "application/json" },
  });

  if (response.ok) {
    setState("ok");
    return;
  }

  const body: unknown = await response.json().catch(() => null);

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

/** Development-only step-up probe kept from `identity-sessions`; it never ships in production. */
export function DevSensitiveCheck() {
  const t = useT();
  const [sensitive, setSensitive] = useState<SensitiveState>("idle");
  const started = useRef(false);

  useEffect(() => {
    if (started.current || sessionStorage.getItem(STEP_UP_PENDING_KEY) !== "1") {
      return;
    }

    started.current = true;
    sessionStorage.removeItem(STEP_UP_PENDING_KEY);
    void runSensitive(setSensitive);
  }, []);

  return (
    <section className="dev-tools" data-dev-tools>
      <div className="dev-tools-text">
        <h2>{t("staff.dev.tools.title")}</h2>
        <p className="muted">{t("staff.dev.tools.body")}</p>
      </div>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        data-sensitive
        onClick={() => void runSensitive(setSensitive)}
      >
        {t("auth.sensitiveCheck")}
      </button>
      {sensitive === "ok" ? (
        <p className="dev-tools-result" data-sensitive-result="ok">
          {t("auth.sensitiveOk")}
        </p>
      ) : null}
      {sensitive === "error" ? (
        <p className="dev-tools-result" data-sensitive-error>
          {t("auth.sensitiveError")}
        </p>
      ) : null}
    </section>
  );
}
