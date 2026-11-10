import { readClientSession } from "../csrf.ts";

function hide(button: HTMLButtonElement): void {
  const article = button.closest<HTMLElement>("[data-announcement]");

  if (article !== null) {
    article.hidden = true;
  }
}

async function dismiss(button: HTMLButtonElement): Promise<void> {
  const announcementId = button.getAttribute("data-announcement-dismiss") ?? "";

  if (announcementId === "") {
    return;
  }

  button.disabled = true;

  try {
    const session = await readClientSession();

    if (!session.authenticated || session.csrfToken === null) {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/auth/login?return_to=${encodeURIComponent(returnTo)}`);
      return;
    }

    const response = await fetch(
      `/api/announcements/${encodeURIComponent(announcementId)}/dismiss`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bulletin-csrf": session.csrfToken,
        },
      },
    );

    if (response.ok) {
      hide(button);
    }
  } catch {
    // The announcement stays visible; the member can try again.
  } finally {
    button.disabled = false;
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-announcement-dismiss]")) {
  button.addEventListener("click", () => {
    void dismiss(button);
  });
}
