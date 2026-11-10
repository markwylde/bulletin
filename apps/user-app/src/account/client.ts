import { readClientSession, readLabels } from "../csrf.ts";

interface Labels {
  readonly saved: string;
  readonly saveFailed: string;
  readonly required: string;
  readonly taken: string;
  readonly invalid: string;
  readonly limit: string;
  readonly sessionsError: string;
  readonly current: string;
  readonly lastSeen: string;
  readonly unknownBrowser: string;
  readonly browsers: Readonly<Record<string, string>>;
}

interface SessionRow {
  readonly id: string;
  readonly kind: string;
  readonly current: boolean;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly ip: string | null;
  readonly browser: string;
}

const labels = readLabels<Labels>("account-labels");

function messageFor(code: string | undefined): string {
  if (labels === null) {
    return "";
  }

  switch (code) {
    case "display_name_required":
      return labels.required;
    case "display_name_taken":
      return labels.taken;
    case "display_name_invalid":
      return labels.invalid;
    case "display_name_change_limit":
      return labels.limit;
    default:
      return labels.saveFailed;
  }
}

async function submitName(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>("[data-account-name-input]");
  const error = document.querySelector<HTMLElement>("[data-account-name-error]");
  const saved = document.querySelector<HTMLElement>("[data-account-name-saved]");
  const button = document.querySelector<HTMLButtonElement>("[data-account-name-submit]");

  if (button !== null) {
    button.disabled = true;
  }

  if (error !== null) {
    error.hidden = true;
  }

  try {
    const session = await readClientSession();

    if (!session.authenticated || session.csrfToken === null) {
      window.location.assign("/auth/login?return_to=%2Faccount");
      return;
    }

    const response = await fetch("/api/me/display-name", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bulletin-csrf": session.csrfToken,
      },
      body: JSON.stringify({ displayName: input?.value ?? "" }),
    });

    if (response.ok) {
      if (saved !== null) {
        saved.hidden = false;
      }

      window.location.reload();
      return;
    }

    const body = (await response.json().catch(() => ({}))) as { readonly code?: string };

    if (error !== null) {
      error.textContent = messageFor(body.code);
      error.hidden = false;
    }
  } catch {
    if (error !== null) {
      error.textContent = labels?.saveFailed ?? "";
      error.hidden = false;
    }
  } finally {
    if (button !== null) {
      button.disabled = false;
    }
  }
}

function formatDate(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  return new Intl.DateTimeFormat(document.documentElement.lang, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function renderSession(row: SessionRow): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "bl-session-list__item";
  item.dataset.accountSession = row.id;

  if (row.current) {
    item.dataset.currentSession = "true";
  }

  const title = document.createElement("span");
  title.className = row.current ? "bl-session-list__current" : "";
  title.textContent = labels?.browsers[row.browser] ?? labels?.unknownBrowser ?? row.browser;
  item.append(title);

  if (row.current && labels !== null) {
    const current = document.createElement("span");
    current.className = "bl-muted";
    current.textContent = labels.current;
    item.append(current);
  }

  const meta = document.createElement("span");
  meta.className = "bl-muted";
  meta.textContent = `${labels?.lastSeen ?? ""} ${formatDate(row.lastSeenAt)}`.trim();
  item.append(meta);

  if (row.ip !== null) {
    const ip = document.createElement("code");
    ip.textContent = row.ip;
    item.append(ip);
  }

  return item;
}

async function loadSessions(): Promise<void> {
  const list = document.querySelector<HTMLElement>("[data-account-session-list]");
  const failure = document.querySelector<HTMLElement>("[data-account-sessions-error]");

  if (list === null) {
    return;
  }

  try {
    const response = await fetch("/api/me/sessions", { headers: { accept: "application/json" } });

    if (!response.ok) {
      throw new Error("sessions request failed");
    }

    const body = (await response.json()) as { readonly sessions: readonly SessionRow[] };

    list.replaceChildren(...body.sessions.map(renderSession));
  } catch {
    if (failure !== null) {
      failure.hidden = false;
    }
  }
}

const nameForm = document.querySelector<HTMLFormElement>("[data-account-name-form]");

if (nameForm !== null) {
  nameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitName();
  });
}

void loadSessions();
