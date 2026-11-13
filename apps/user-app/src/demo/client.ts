import { readClientSession } from "../csrf.ts";

const form = document.querySelector<HTMLFormElement>("[data-demo-unlock]");

async function unlock(
  target: HTMLFormElement,
  error: HTMLElement | null,
  submit: HTMLButtonElement | null,
): Promise<void> {
  const forumId = target.getAttribute("data-forum-id") ?? "";
  const password = target.querySelector<HTMLInputElement>('input[name="password"]')?.value ?? "";

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

if (form !== null) {
  const error = document.querySelector<HTMLElement>("[data-demo-unlock-error]");
  const submit = form.querySelector<HTMLButtonElement>("[data-demo-unlock-submit]");

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void unlock(form, error, submit);
  });
  // The template renders the control disabled so a click before this module has run can never
  // fall back to a native form submission and put the password in the URL (ADR 0018).
  if (submit !== null) {
    submit.disabled = false;
  }
}
