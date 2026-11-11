import { readClientSession } from "../csrf.ts";

async function deleteAttachment(id: string, button: HTMLButtonElement): Promise<void> {
  const error = document.querySelector<HTMLElement>("[data-attachment-delete-error]");
  const session = await readClientSession();

  if (!session.authenticated || session.csrfToken === null) {
    window.location.assign(`/auth/login?return_to=${encodeURIComponent("/account/attachments")}`);
    return;
  }

  button.disabled = true;

  try {
    const response = await fetch(`/api/attachments/${id}/delete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bulletin-csrf": session.csrfToken,
      },
      body: "{}",
    });

    if (response.ok) {
      window.location.reload();
      return;
    }
  } catch {
    // Fall through to the visible error below.
  } finally {
    button.disabled = false;
  }

  if (error !== null) {
    error.hidden = false;
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-attachment-delete]")) {
  button.addEventListener("click", () => {
    const id = button.dataset.attachmentDelete;

    if (id !== undefined && id !== "") {
      void deleteAttachment(id, button);
    }
  });
}
