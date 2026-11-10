import { readClientSession, readLabels } from "../csrf.ts";

interface Labels {
  readonly required: string;
  readonly taken: string;
  readonly invalid: string;
  readonly limit: string;
  readonly saveFailed: string;
}

const labels = readLabels<Labels>("display-name-labels");
const form = document.querySelector<HTMLFormElement>("[data-display-name-form]");

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

async function submitName(target: HTMLFormElement): Promise<void> {
  const input = target.querySelector<HTMLInputElement>("[data-display-name-input]");
  const error = document.querySelector<HTMLElement>("[data-display-name-error]");
  const button = target.querySelector<HTMLButtonElement>("[data-display-name-submit]");
  const returnTo = target.getAttribute("data-return-to") ?? "/";

  if (button !== null) {
    button.disabled = true;
  }

  if (error !== null) {
    error.hidden = true;
  }

  try {
    const session = await readClientSession();

    if (!session.authenticated || session.csrfToken === null) {
      window.location.assign("/auth/login?return_to=%2Fdisplay-name");
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
      window.location.assign(returnTo);
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

if (form !== null) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitName(form);
  });
}
