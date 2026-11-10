import { CSRF_STORAGE_KEY } from "@bulletin/domain/auth/browser";

async function csrfToken(): Promise<string | null> {
  try {
    const stored = sessionStorage.getItem(CSRF_STORAGE_KEY);

    if (stored !== null) {
      return stored;
    }
  } catch {
    // Fall through to the session endpoint.
  }

  try {
    const response = await fetch("/api/auth/session", {
      headers: { accept: "application/json" },
    });
    const body = (await response.json()) as { csrfToken?: string | null };
    return body.csrfToken ?? null;
  } catch {
    return null;
  }
}

async function mark(url: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  const token = await csrfToken();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { "x-bulletin-csrf": token }),
      },
      body: "{}",
    });

    if (response.ok) {
      window.location.reload();
      return;
    }
  } catch {
    // Leave the page usable; the member can retry.
  } finally {
    button.disabled = false;
  }
}

document.addEventListener("click", (event) => {
  const target = event.target;

  if (!(target instanceof Element)) {
    return;
  }

  const forum = target.closest<HTMLElement>("[data-mark-forum-read]");

  if (forum !== null) {
    void mark(`/api/forums/${forum.dataset.markForumRead ?? ""}/read`, forum as HTMLButtonElement);
    return;
  }

  const board = target.closest<HTMLElement>("[data-mark-board-read]");

  if (board !== null) {
    void mark("/api/me/read-all", board as HTMLButtonElement);
  }
});
