import { clientCsrfToken, readLabels } from "../csrf.ts";

interface Labels {
  readonly saved: string;
  readonly saveFailed: string;
  readonly required: string;
  readonly invalid: string;
  readonly notEditable: string;
}

const labels = readLabels<Labels>("profile-edit-labels");

function messageFor(code: string | undefined): string {
  switch (code) {
    case "required":
      return labels?.required ?? "";
    case "invalid":
      return labels?.invalid ?? "";
    case "not_editable":
      return labels?.notEditable ?? "";
    default:
      return labels?.saveFailed ?? "";
  }
}

function fieldValues(): Record<string, unknown> | null {
  const values: Record<string, unknown> = {};

  for (const row of document.querySelectorAll<HTMLElement>("[data-profile-field]")) {
    const id = row.dataset.profileField ?? "";
    const type = row.dataset.profileFieldType ?? "";

    if (id === "") {
      continue;
    }

    if (type === "multiselect") {
      values[id] = [...row.querySelectorAll<HTMLInputElement>("[data-profile-option]:checked")].map(
        (input) => input.value,
      );
      continue;
    }

    const control = row.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "[data-profile-field-input]",
    );

    if (control === null) {
      continue;
    }

    if (type === "number") {
      if (control.value.trim() !== "") {
        const value = Number(control.value);

        if (!Number.isFinite(value)) {
          return null;
        }

        values[id] = value;
      }
      continue;
    }

    values[id] = control.value;
  }

  return values;
}

async function submit(form: HTMLFormElement): Promise<void> {
  const button = form.querySelector<HTMLButtonElement>("[data-profile-save]");
  const error = document.querySelector<HTMLElement>("[data-profile-error]");
  const saved = document.querySelector<HTMLElement>("[data-profile-saved]");
  const about = form.querySelector<HTMLTextAreaElement>("[data-profile-about]");
  const hideOnline = form.querySelector<HTMLInputElement>("[data-profile-hide-online]");
  const hideFromList = form.querySelector<HTMLInputElement>("[data-profile-hide-from-list]");
  const values = fieldValues();

  if (error !== null) {
    error.hidden = true;
  }

  if (saved !== null) {
    saved.hidden = true;
  }

  if (values === null) {
    if (error !== null) {
      error.textContent = labels?.invalid ?? "";
      error.hidden = false;
    }
    return;
  }

  if (button !== null) {
    button.disabled = true;
  }

  try {
    const token = await clientCsrfToken();

    if (token === null) {
      window.location.assign("/auth/login?return_to=%2Faccount%2Fprofile");
      return;
    }

    const response = await fetch("/api/me/profile", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bulletin-csrf": token,
      },
      body: JSON.stringify({
        about: about?.value ?? "",
        hideOnline: hideOnline?.checked === true,
        hideFromMemberList: hideFromList?.checked === true,
        values,
      }),
    });

    if (response.ok) {
      if (saved !== null) {
        saved.hidden = false;
      }
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

const form = document.querySelector<HTMLFormElement>("[data-profile-edit-form]");

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  void submit(form);
});
