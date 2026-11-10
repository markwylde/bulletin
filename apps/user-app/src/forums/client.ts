import { readClientSession } from "../csrf.ts";

const RULES_PREFIX = "bulletin.rules.";

function applyRememberedRules(): void {
  for (const details of document.querySelectorAll<HTMLDetailsElement>("[data-rules]")) {
    const forumId = details.getAttribute("data-forum-id") ?? "";

    if (forumId === "") {
      continue;
    }

    try {
      const stored = localStorage.getItem(`${RULES_PREFIX}${forumId}`);

      if (stored !== null) {
        details.open = stored === "open";
      }
    } catch {
      // Storage can be unavailable (private mode); the default open state still works.
    }

    details.addEventListener("toggle", () => {
      try {
        localStorage.setItem(`${RULES_PREFIX}${forumId}`, details.open ? "open" : "closed");
      } catch {
        // The preference is an enhancement, not a requirement.
      }
    });
  }
}

async function unlock(
  form: HTMLFormElement,
  error: HTMLElement | null,
  submit: HTMLButtonElement | null,
): Promise<void> {
  const forumId = form.getAttribute("data-forum-id") ?? "";
  const password = form.querySelector<HTMLInputElement>('input[name="password"]')?.value ?? "";

  if (submit !== null) {
    submit.disabled = true;
  }

  try {
    const session = await readClientSession();

    if (!session.authenticated || session.csrfToken === null) {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/auth/login?return_to=${encodeURIComponent(returnTo)}`);
      return;
    }

    const response = await fetch(`/api/forums/${encodeURIComponent(forumId)}/unlock`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bulletin-csrf": session.csrfToken,
      },
      body: JSON.stringify({ password }),
    });

    if (response.ok) {
      window.location.reload();
      return;
    }

    if (error !== null) {
      error.hidden = false;
    }
  } catch {
    if (error !== null) {
      error.hidden = false;
    }
  } finally {
    if (submit !== null) {
      submit.disabled = false;
    }
  }
}

const unlockForm = document.querySelector<HTMLFormElement>("[data-forum-unlock]");

applyRememberedRules();

if (unlockForm !== null) {
  const error = document.querySelector<HTMLElement>("[data-forum-unlock-error]");
  const submit = unlockForm.querySelector<HTMLButtonElement>("[data-forum-unlock-submit]");

  unlockForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void unlock(unlockForm, error, submit);
  });
}
