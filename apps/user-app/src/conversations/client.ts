import { clientCsrfToken } from "../csrf.ts";

interface PickedMember {
  readonly id: string;
  readonly name: string;
}

interface SuggestedMember {
  readonly id: string;
  readonly displayName: string;
}

const SEARCH_DELAY_MS = 180;

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

function showError(element: Element | null, show: boolean): void {
  if (element instanceof HTMLElement) {
    element.hidden = !show;
  }
}

const ERROR_LABEL_KEYS: Readonly<Record<string, string>> = {
  recipient_limit: "labelRecipientLimit",
  daily_limit: "labelDailyLimit",
  quota_reached: "labelQuota",
  pm_disabled: "labelPmDisabled",
  recipient_unavailable: "labelRecipientUnavailable",
  invite_blocked: "labelInviteBlocked",
  already_participant: "labelAlreadyParticipant",
  not_found: "labelNotFound",
};

/** Prefer the code-specific translated label from the form, then the template's generic text. */
async function errorText(
  response: Response,
  container: Element | null,
  fallback: Element | null,
): Promise<string> {
  const generic = fallback instanceof HTMLElement ? (fallback.textContent ?? "") : "";
  const body = (await response.json().catch(() => ({}))) as { readonly code?: string };
  const key = body.code === undefined ? undefined : ERROR_LABEL_KEYS[body.code];
  const label = key === undefined ? undefined : (container as HTMLElement | null)?.dataset[key];

  return label ?? generic;
}

function setErrorText(element: Element | null, text: string): void {
  if (element instanceof HTMLElement) {
    element.textContent = text;
  }
}

function buttonsIn(container: Element): readonly HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button")];
}

function setDisabled(container: Element, disabled: boolean): void {
  for (const button of buttonsIn(container)) {
    button.disabled = disabled;
  }
}

function inputValue(form: HTMLFormElement, name: string): string {
  return new FormData(form).get(name)?.toString() ?? "";
}

/** A small member autocomplete that emits hidden inputs with the chosen IDs. */
function setupRecipientPicker(picker: HTMLElement): () => readonly PickedMember[] {
  const search = picker.querySelector<HTMLInputElement>("[data-recipient-search]");
  const results = picker.querySelector<HTMLElement>("[data-recipient-results]");
  const selected = picker.querySelector<HTMLElement>("[data-recipient-selected]");
  const empty = picker.querySelector<HTMLElement>("[data-recipient-empty]");
  const suggested = picker.dataset.suggestUrl ?? "/api/members/suggest";
  const labelRemove = picker.dataset.labelRemove ?? "";
  const picked: PickedMember[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (search === null || results === null || selected === null) {
    return () => picked;
  }

  const render = (): void => {
    selected.replaceChildren();
    picked.forEach((member) => {
      const chip = document.createElement("span");
      chip.className = "bl-chip";
      chip.dataset.recipientSelected = member.id;
      const name = document.createElement("span");
      name.textContent = member.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "bl-button bl-button--quiet bl-button--small";
      remove.dataset.recipientRemove = member.id;
      remove.textContent = "×";
      remove.title = labelRemove;
      remove.addEventListener("click", () => {
        const index = picked.findIndex((candidate) => candidate.id === member.id);
        if (index >= 0) {
          picked.splice(index, 1);
          render();
        }
      });
      chip.append(name, remove);
      selected.append(chip);

      const hidden = document.createElement("input");
      hidden.type = "hidden";
      hidden.dataset.recipientId = member.id;
      hidden.value = member.id;
      selected.append(hidden);
    });
  };

  const add = (member: SuggestedMember): void => {
    if (picked.some((candidate) => candidate.id === member.id)) {
      return;
    }

    picked.push({ id: member.id, name: member.displayName });
    render();
    search.value = "";
    results.hidden = true;
  };

  const searchMembers = async (): Promise<void> => {
    const query = search.value.trim();

    if (query === "") {
      results.hidden = true;
      if (empty !== null) {
        empty.hidden = true;
      }
      return;
    }

    const response = await fetch(`${suggested}?q=${encodeURIComponent(query)}`, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      return;
    }

    const body = (await response.json()) as { members?: readonly SuggestedMember[] };
    const members = body.members ?? [];
    results.replaceChildren();

    for (const member of members) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bl-recipient-results__item";
      button.dataset.suggestId = member.id;
      button.textContent = member.displayName;
      button.addEventListener("click", () => add(member));
      item.append(button);
      results.append(item);
    }

    results.hidden = members.length === 0;
    if (empty !== null) {
      empty.hidden = members.length > 0;
    }
  };

  search.addEventListener("input", () => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      void searchMembers();
    }, SEARCH_DELAY_MS);
  });

  return () => picked;
}

const pickers = new WeakMap<HTMLElement, () => readonly PickedMember[]>();

function pickerFor(container: Element | null): () => readonly PickedMember[] {
  const picker =
    container?.matches("[data-recipient-picker]") === true
      ? (container as HTMLElement)
      : (container?.querySelector<HTMLElement>("[data-recipient-picker]") ?? null);

  if (picker === null) {
    return () => [];
  }

  const existing = pickers.get(picker);

  if (existing !== undefined) {
    return existing;
  }

  const getter = setupRecipientPicker(picker);
  pickers.set(picker, getter);
  return getter;
}

function newConversation(form: HTMLFormElement): void {
  const selected = pickerFor(form);
  const error = form.querySelector("[data-form-error]");
  const submit = form.querySelector<HTMLButtonElement>("[data-new-conversation-submit]");

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const recipientIds = selected().map((member) => member.id);

    if (submit !== null) {
      submit.disabled = true;
    }
    showError(error, false);

    void postJson("/api/conversations", {
      title: inputValue(form, "title"),
      bodyMd: inputValue(form, "bodyMd"),
      recipientIds,
    })
      .then(async (response) => {
        if (!response.ok) {
          setErrorText(error, await errorText(response, form, error));
          showError(error, true);
          return;
        }

        const body = (await response.json()) as { conversationId?: string };
        window.location.assign(
          typeof body.conversationId === "string"
            ? `/conversations/${body.conversationId}`
            : "/conversations",
        );
      })
      .catch(() => showError(error, true))
      .finally(() => {
        if (submit !== null) {
          submit.disabled = false;
        }
      });
  });
}

function reply(form: HTMLFormElement): void {
  const error = form.querySelector("[data-form-error]");
  const submit = form.querySelector<HTMLButtonElement>("[data-reply-submit]");
  const conversationId = form.dataset.conversationId ?? "";

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    if (submit !== null) {
      submit.disabled = true;
    }
    showError(error, false);

    void postJson(`/api/conversations/${conversationId}/replies`, {
      bodyMd: inputValue(form, "bodyMd"),
    })
      .then(async (response) => {
        if (!response.ok) {
          setErrorText(error, await errorText(response, form, error));
          showError(error, true);
          return;
        }

        window.location.reload();
      })
      .catch(() => showError(error, true))
      .finally(() => {
        if (submit !== null) {
          submit.disabled = false;
        }
      });
  });
}

function archive(button: HTMLButtonElement): void {
  const container = button.closest<HTMLElement>("[data-conversation-page]");
  const conversationId = container?.dataset.conversationId ?? "";
  const archived = button.dataset.conversationArchive === "true";
  const error = container?.querySelector("[data-conversation-error]") ?? null;
  setDisabled(button.parentElement ?? button, true);
  showError(error, false);

  void postJson(`/api/conversations/${conversationId}/archive`, { archived })
    .then((response) => {
      if (!response.ok) {
        showError(error, true);
        return;
      }

      window.location.assign(`/conversations?folder=${archived ? "archive" : "inbox"}`);
    })
    .catch(() => showError(error, true))
    .finally(() => setDisabled(button.parentElement ?? button, false));
}

function leave(button: HTMLButtonElement): void {
  const container = button.closest<HTMLElement>("[data-conversation-page]");
  const conversationId = container?.dataset.conversationId ?? "";
  const block = container?.querySelector<HTMLInputElement>("[data-leave-block]")?.checked === true;
  const error = container?.querySelector("[data-leave-error]") ?? null;

  if (button.dataset.confirm !== undefined && !window.confirm(button.dataset.confirm)) {
    return;
  }

  setDisabled(button.parentElement ?? button, true);
  showError(error, false);

  void postJson(`/api/conversations/${conversationId}/leave`, { blockReinvite: block })
    .then((response) => {
      if (!response.ok) {
        showError(error, true);
        return;
      }

      window.location.assign("/conversations");
    })
    .catch(() => showError(error, true))
    .finally(() => setDisabled(button.parentElement ?? button, false));
}

function removeParticipant(button: HTMLButtonElement): void {
  const container = button.closest<HTMLElement>("[data-conversation-page]");
  const conversationId = container?.dataset.conversationId ?? "";
  const memberId = button.dataset.conversationRemove ?? "";
  const error = container?.querySelector("[data-conversation-error]") ?? null;

  if (button.dataset.confirm !== undefined && !window.confirm(button.dataset.confirm)) {
    return;
  }

  setDisabled(button.parentElement ?? button, true);
  showError(error, false);

  void postJson(`/api/conversations/${conversationId}/participants`, {
    action: "remove",
    memberId,
  })
    .then((response) => {
      if (!response.ok) {
        showError(error, true);
        return;
      }

      window.location.reload();
    })
    .catch(() => showError(error, true))
    .finally(() => setDisabled(button.parentElement ?? button, false));
}

function invite(button: HTMLButtonElement): void {
  const container = button.closest<HTMLElement>("[data-conversation-manage]");
  const page = button.closest<HTMLElement>("[data-conversation-page]");
  const conversationId = page?.dataset.conversationId ?? "";
  const selected = pickerFor(container);
  const error = container?.querySelector("[data-invite-error]") ?? null;
  const memberId = selected()[0]?.id;

  if (memberId === undefined) {
    showError(error, true);
    return;
  }

  setDisabled(container ?? button, true);
  showError(error, false);

  void postJson(`/api/conversations/${conversationId}/participants`, {
    action: "invite",
    memberId,
  })
    .then(async (response) => {
      if (!response.ok) {
        setErrorText(error, await errorText(response, container, error));
        showError(error, true);
        return;
      }

      window.location.reload();
    })
    .catch(() => showError(error, true))
    .finally(() => setDisabled(container ?? button, false));
}

function markRead(container: HTMLElement): void {
  const conversationId = container.dataset.conversationId ?? "";

  void postJson(`/api/conversations/${conversationId}/read`, {}).catch(() => undefined);
}

for (const picker of document.querySelectorAll<HTMLElement>("[data-recipient-picker]")) {
  pickerFor(picker);
}

for (const form of document.querySelectorAll<HTMLFormElement>("[data-new-conversation-form]")) {
  newConversation(form);
}

for (const form of document.querySelectorAll<HTMLFormElement>("[data-conversation-reply-form]")) {
  reply(form);
}

document.addEventListener("click", (event) => {
  const target = event.target;

  if (!(target instanceof Element)) {
    return;
  }

  const archiveButton = target.closest<HTMLButtonElement>("[data-conversation-archive]");
  if (archiveButton !== null) {
    archive(archiveButton);
    return;
  }

  const leaveButton = target.closest<HTMLButtonElement>("[data-conversation-leave]");
  if (leaveButton !== null) {
    leave(leaveButton);
    return;
  }

  const removeButton = target.closest<HTMLButtonElement>("[data-conversation-remove]");
  if (removeButton !== null) {
    removeParticipant(removeButton);
    return;
  }

  const inviteButton = target.closest<HTMLButtonElement>("[data-conversation-invite]");
  if (inviteButton !== null) {
    invite(inviteButton);
  }
});

const conversationPage = document.querySelector<HTMLElement>("[data-conversation-page]");

if (conversationPage !== null) {
  conversationPage.dataset.conversationReady = "true";
  markRead(conversationPage);
}

const inboxPage = document.querySelector<HTMLElement>("[data-conversations-page]");

if (inboxPage !== null) {
  inboxPage.dataset.conversationsReady = "true";
}
