import { clientCsrfToken, readLabels } from "../csrf.ts";

interface Labels {
  readonly saved: string;
  readonly saveFailed: string;
  readonly required: string;
  readonly invalid: string;
  readonly notEditable: string;
  readonly signatureDisabled: string;
  readonly signatureTooLong: string;
  readonly signatureTooManyLines: string;
  readonly signatureTooManyImages: string;
  readonly signatureTooManyLinks: string;
  readonly customTitleNotAllowed: string;
  readonly customTitleTooLong: string;
  readonly tooManyFeatured: string;
}

const labels = readLabels<Labels>("profile-edit-labels");

function withLimit(pattern: string | undefined, limit: unknown): string {
  const maximum = typeof limit === "number" && Number.isFinite(limit) ? String(limit) : "";

  return (pattern ?? "").replaceAll("{limit}", maximum);
}

function messageFor(code: string | undefined, limit: unknown): string {
  switch (code) {
    case "required":
      return labels?.required ?? "";
    case "invalid":
      return labels?.invalid ?? "";
    case "not_editable":
      return labels?.notEditable ?? "";
    case "signature_disabled":
      return labels?.signatureDisabled ?? "";
    case "signature_too_long":
      return withLimit(labels?.signatureTooLong, limit);
    case "signature_too_many_lines":
      return withLimit(labels?.signatureTooManyLines, limit);
    case "signature_too_many_images":
      return withLimit(labels?.signatureTooManyImages, limit);
    case "signature_too_many_links":
      return withLimit(labels?.signatureTooManyLinks, limit);
    case "custom_title_not_allowed":
      return labels?.customTitleNotAllowed ?? "";
    case "custom_title_too_long":
      return withLimit(labels?.customTitleTooLong, limit);
    case "too_many_featured":
      return labels?.tooManyFeatured ?? "";
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
  const signature = form.querySelector<HTMLTextAreaElement>("[data-profile-signature]");
  const hideOnline = form.querySelector<HTMLInputElement>("[data-profile-hide-online]");
  const hideFromList = form.querySelector<HTMLInputElement>("[data-profile-hide-from-list]");
  const hideSignatures = form.querySelector<HTMLInputElement>("[data-profile-hide-signatures]");
  const hideFriends = form.querySelector<HTMLInputElement>("[data-profile-hide-friends]");
  const customTitle = form.querySelector<HTMLInputElement>("[data-profile-custom-title]");
  const featuredBadges = [
    ...form.querySelectorAll<HTMLInputElement>("[data-profile-featured-badge]:checked"),
  ].map((input) => input.value);
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
        ...(signature === null ? {} : { signatureMd: signature.value }),
        hideOnline: hideOnline?.checked === true,
        hideFromMemberList: hideFromList?.checked === true,
        ...(hideSignatures === null ? {} : { hideSignatures: hideSignatures.checked }),
        hideFriends: hideFriends?.checked === true,
        ...(customTitle === null ? {} : { customTitle: customTitle.value }),
        ...(form.querySelector("[data-profile-featured-badge]") === null ? {} : { featuredBadges }),
        values,
      }),
    });

    if (response.ok) {
      if (saved !== null) {
        saved.hidden = false;
      }
      return;
    }

    const body = (await response.json().catch(() => ({}))) as {
      readonly code?: string;
      readonly limit?: unknown;
    };

    if (error !== null) {
      error.textContent = messageFor(body.code, body.limit);
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

// The template renders the save control disabled so a click before this module has run can
// never fall back to a native form submission that reloads the page and drops the edit.
const saveButton = form?.querySelector<HTMLButtonElement>("[data-profile-save]");

if (saveButton !== null && saveButton !== undefined) {
  saveButton.disabled = false;
}
