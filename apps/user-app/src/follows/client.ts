import { clientCsrfToken } from "../csrf.ts";
import { setFollowState } from "./dom.ts";

const TARGET = /^(topic|forum|member):([1-9]\d{0,18})$/;

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

function errorFor(element: Element | null): HTMLElement | null {
  const container = element?.closest<HTMLElement>("[data-follow-context], [data-follow-row]");
  return container?.querySelector<HTMLElement>("[data-follow-error]") ?? null;
}

function buttonsIn(element: Element): readonly HTMLButtonElement[] {
  const container = element.closest<HTMLElement>("[data-follow-context], [data-follow-row]");
  return container === null ? [] : [...container.querySelectorAll<HTMLButtonElement>("button")];
}

/** Follow/unfollow a target and update the neutral buttons in place. */
async function toggle(button: HTMLButtonElement, following: boolean): Promise<void> {
  const container = button.closest<HTMLElement>("[data-follow-context]");
  const context = container?.getAttribute("data-follow-context") ?? "";
  const match = TARGET.exec(context);

  if (container === null || match === null) {
    return;
  }

  const error = errorFor(container);
  const controls = buttonsIn(button);

  for (const control of controls) {
    control.disabled = true;
  }

  try {
    const response = await postJson("/api/follows", {
      kind: match[1],
      id: match[2],
      following,
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

    setFollowState(context, following);
  } catch {
    if (error !== null) {
      error.hidden = false;
    }
  } finally {
    for (const control of buttonsIn(button)) {
      control.disabled = false;
    }
  }
}

async function removeFollow(button: HTMLButtonElement): Promise<void> {
  const container = button.closest<HTMLElement>("[data-follow-row]");
  const target = container?.getAttribute("data-follow-row") ?? "";
  const match = TARGET.exec(target);

  if (container === null || match === null) {
    return;
  }

  const error = errorFor(container);

  for (const control of buttonsIn(button)) {
    control.disabled = true;
  }

  try {
    const response = await postJson("/api/follows", {
      kind: match[1],
      id: match[2],
      following: false,
    });

    if (!response.ok) {
      if (error !== null) {
        error.hidden = false;
      }

      return;
    }

    const list = container.closest<HTMLElement>("[data-follow-list]");
    container.remove();

    if (list !== null && list.querySelectorAll("[data-follow-row]").length === 0) {
      const empty = list.querySelector<HTMLElement>("[data-follow-empty]");

      if (empty !== null) {
        empty.hidden = false;
      }
    }
  } catch {
    if (error !== null) {
      error.hidden = false;
    }
  } finally {
    for (const control of buttonsIn(button)) {
      control.disabled = false;
    }
  }
}

async function saveAutoFollow(input: HTMLInputElement): Promise<void> {
  const status = document.querySelector<HTMLElement>("[data-auto-follow-status]");
  const error = document.querySelector<HTMLElement>("[data-auto-follow-error]");
  input.disabled = true;

  try {
    const response = await postJson("/api/me/follow-settings", {
      autoFollowTopics: input.checked,
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

document.addEventListener("click", (event) => {
  const target = event.target;

  if (!(target instanceof Element)) {
    return;
  }

  const followButton = target.closest<HTMLButtonElement>("[data-follow-action]");

  if (followButton !== null) {
    void toggle(followButton, followButton.getAttribute("data-follow-action") === "follow");
    return;
  }

  const removeButton = target.closest<HTMLButtonElement>("[data-follow-remove]");

  if (removeButton !== null) {
    void removeFollow(removeButton);
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;

  if (target instanceof HTMLInputElement && target.hasAttribute("data-auto-follow")) {
    void saveAutoFollow(target);
  }
});
