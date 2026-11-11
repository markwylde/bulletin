import { clientCsrfToken } from "../csrf.ts";

async function postJson(url: string, body: unknown): Promise<Response> {
  const token = await clientCsrfToken();

  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { "x-bulletin-csrf": token }),
    },
    body: JSON.stringify(body),
  });
}

function setBellCount(count: number): void {
  for (const slot of document.querySelectorAll<HTMLElement>(
    '[data-overlay-count="notifications"]',
  )) {
    slot.textContent = String(count);
    slot.hidden = count <= 0;
  }
}

function showError(): void {
  const error = document.querySelector<HTMLElement>("[data-notifications-error]");

  if (error !== null) {
    error.hidden = false;
  }
}

function markRowsRead(): void {
  for (const row of document.querySelectorAll<HTMLElement>("[data-notification-row]")) {
    row.setAttribute("data-unread", "false");
    row.classList.remove("is-unread");
  }

  setBellCount(0);
}

async function markAll(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>("[data-notifications-read-all]");
  const status = document.querySelector<HTMLElement>("[data-notifications-read-status]");
  const error = document.querySelector<HTMLElement>("[data-notifications-error]");

  if (button === null || button.disabled) {
    return;
  }

  button.disabled = true;

  try {
    const response = await postJson("/api/notifications/read", { all: true });

    if (!response.ok) {
      button.disabled = false;
      showError();
      return;
    }

    markRowsRead();

    if (status !== null) {
      status.hidden = false;
    }

    if (error !== null) {
      error.hidden = true;
    }
  } catch {
    button.disabled = false;
    showError();
  }
}

async function openNotification(link: HTMLAnchorElement): Promise<void> {
  const id = link.getAttribute("data-notification-link");
  const href = link.getAttribute("href");

  if (id === null || href === null) {
    return;
  }

  try {
    const response = await postJson("/api/notifications/read", { id });

    if (response.ok) {
      const row = link.closest<HTMLElement>("[data-notification-row]");
      row?.setAttribute("data-unread", "false");
      row?.classList.remove("is-unread");
      const count = document.querySelectorAll('[data-notification-row][data-unread="true"]').length;
      setBellCount(count);
    }
  } catch {
    // Reading the notification must not block opening it.
  }

  window.location.assign(href);
}

document.addEventListener("click", (event) => {
  const target = event.target;

  if (!(target instanceof Element)) {
    return;
  }

  const readAll = target.closest<HTMLButtonElement>("[data-notifications-read-all]");

  if (readAll !== null) {
    event.preventDefault();
    void markAll();
    return;
  }

  const link = target.closest<HTMLAnchorElement>("[data-notification-link]");

  if (link !== null) {
    event.preventDefault();
    void openNotification(link);
  }
});

async function savePreference(input: HTMLInputElement): Promise<void> {
  const type = input.getAttribute("data-preference-type");
  const channel = input.getAttribute("data-preference-channel");
  const status = document.querySelector<HTMLElement>("[data-notification-preference-status]");
  const error = document.querySelector<HTMLElement>("[data-notification-preference-error]");

  if (type === null || channel === null) {
    return;
  }

  input.disabled = true;

  try {
    const response = await postJson("/api/notifications/preferences", {
      type,
      channel,
      enabled: input.checked,
    });

    if (!response.ok) {
      input.checked = !input.checked;

      if (error !== null) {
        error.hidden = false;
      }

      return;
    }

    if (error !== null) {
      error.hidden = true;
    }

    if (status !== null) {
      status.hidden = false;
    }
  } catch {
    input.checked = !input.checked;

    if (error !== null) {
      error.hidden = false;
    }
  } finally {
    input.disabled = false;
  }
}

document.addEventListener("change", (event) => {
  const target = event.target;

  if (target instanceof HTMLInputElement && target.hasAttribute("data-notification-preference")) {
    void savePreference(target);
  }
});

async function saveDigestFrequency(select: HTMLSelectElement): Promise<void> {
  const status = document.querySelector<HTMLElement>("[data-notification-preference-status]");
  const error = document.querySelector<HTMLElement>("[data-notification-preference-error]");
  select.disabled = true;

  try {
    const response = await postJson("/api/notifications/digest", {
      frequency: select.value,
    });

    if (!response.ok) {
      if (error !== null) {
        error.hidden = false;
      }

      return;
    }

    if (error !== null) {
      error.hidden = true;
    }

    if (status !== null) {
      status.hidden = false;
    }
  } catch {
    if (error !== null) {
      error.hidden = false;
    }
  } finally {
    select.disabled = false;
  }
}

document.addEventListener("change", (event) => {
  const target = event.target;

  if (target instanceof HTMLSelectElement && target.hasAttribute("data-digest-frequency")) {
    void saveDigestFrequency(target);
  }
});
