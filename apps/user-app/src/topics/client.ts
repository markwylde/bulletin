import { CSRF_STORAGE_KEY } from "@bulletin/domain/auth/browser";

async function csrfToken(): Promise<string | null> {
  try {
    const stored = sessionStorage.getItem(CSRF_STORAGE_KEY);

    if (stored !== null) {
      return stored;
    }
  } catch {
    // Storage can be unavailable; fall through to the session endpoint.
  }

  try {
    const response = await fetch("/api/auth/session", {
      headers: { accept: "application/json" },
    });
    const body = (await response.json()) as { csrfToken?: string | null };
    const token = body.csrfToken ?? null;

    if (token !== null) {
      try {
        sessionStorage.setItem(CSRF_STORAGE_KEY, token);
      } catch {
        // The request still carries the token in this page.
      }
    }

    return token;
  } catch {
    return null;
  }
}

async function postJson(url: string, body: unknown): Promise<Response> {
  const token = await csrfToken();

  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { "x-bulletin-csrf": token }),
    },
    body: JSON.stringify(body),
  });
}

function showError(form: HTMLFormElement, show: boolean): void {
  const error = form.querySelector<HTMLElement>("[data-form-error]");

  if (error !== null) {
    error.hidden = !show;
  }
}

function submitButton(form: HTMLFormElement): HTMLButtonElement | null {
  return form.querySelector<HTMLButtonElement>("button[type=submit]");
}

async function submitForm(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const bodyMd = data.get("bodyMd");
  const button = submitButton(form);
  const request = form.matches("[data-new-topic-form]")
    ? postJson(`/api/forums/${form.dataset.forumId ?? ""}/topics`, {
        title: String(data.get("title") ?? ""),
        bodyMd: String(bodyMd ?? ""),
        ...(String(data.get("prefixId") ?? "") === ""
          ? {}
          : { prefixId: String(data.get("prefixId")) }),
      })
    : form.matches("[data-reply-form]")
      ? postJson(`/api/topics/${form.dataset.topicId ?? ""}/replies`, {
          bodyMd: String(bodyMd ?? ""),
        })
      : postJson(`/api/posts/${form.dataset.postId ?? ""}/edit`, {
          bodyMd: String(bodyMd ?? ""),
          ...(form.querySelector<HTMLInputElement>("input[name=redact]") === null
            ? {}
            : {
                redact:
                  form.querySelector<HTMLInputElement>("input[name=redact]")?.checked === true,
              }),
        });

  if (button !== null) {
    button.disabled = true;
  }
  showError(form, false);

  try {
    const response = await request;

    if (!response.ok) {
      showError(form, true);
      return;
    }

    const result = (await response.json()) as { readonly url?: string | null };

    if (typeof result.url === "string") {
      window.location.assign(result.url);
      return;
    }

    window.location.reload();
  } catch {
    showError(form, true);
  } finally {
    if (button !== null) {
      button.disabled = false;
    }
  }
}

function quoteStorageKey(topicId: string): string {
  return `bulletin:quotes:${topicId}`;
}

function readQuotes(topicId: string): string[] {
  try {
    const raw = sessionStorage.getItem(quoteStorageKey(topicId));
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);

    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && /^\d+$/.test(value))
      : [];
  } catch {
    return [];
  }
}

function writeQuotes(topicId: string, ids: readonly string[]): void {
  try {
    sessionStorage.setItem(quoteStorageKey(topicId), JSON.stringify(ids));
  } catch {
    // Selection is an enhancement; the editor still works without storage.
  }
}

function markQuoteButtons(topicId: string): void {
  const selected = new Set(readQuotes(topicId));

  for (const button of document.querySelectorAll<HTMLElement>("[data-quote-post]")) {
    const active = selected.has(button.dataset.quotePost ?? "");
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.classList.toggle("is-active", active);
  }
}

function quoteDirectives(ids: readonly string[]): string {
  return ids.map((id) => `:::quote{source="post:${id}"}\n:::\n\n`).join("");
}

function openReplyForm(topicId: string): void {
  const form = document.querySelector<HTMLFormElement>("[data-reply-form]");

  if (form === null) {
    return;
  }

  form.hidden = false;
  form.scrollIntoView({ block: "start", behavior: "smooth" });
  const selected = readQuotes(topicId);

  if (selected.length > 0) {
    // The island hydrates after the form is revealed, so wait for its ready marker before
    // dispatching the insert; otherwise the event has no listener yet.
    const started = Date.now();
    const insert = (): void => {
      if (form.querySelector("[data-editor-ready='true']") === null) {
        if (Date.now() - started < 5_000) {
          window.setTimeout(insert, 25);
        }

        return;
      }

      window.dispatchEvent(
        new CustomEvent("bulletin:insert-markdown", {
          detail: { text: quoteDirectives(selected) },
        }),
      );
      writeQuotes(topicId, []);
      markQuoteButtons(topicId);
    };

    insert();
  }
}

function textFrom(bodyMd: string): string[] {
  return bodyMd.replace(/\r\n/g, "\n").split("\n");
}

/** A compact line diff: common prefix/suffix stays plain, the middle is removed/added. */
function diffLines(previous: string, next: string): HTMLElement {
  const before = textFrom(previous);
  const after = textFrom(next);
  let prefix = 0;

  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  let suffix = 0;

  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const fragment = document.createDocumentFragment();
  const block = document.createElement("pre");
  block.className = "bl-diff";

  for (const line of before.slice(0, prefix)) {
    fragment.append(`${line}\n`);
  }

  for (const line of before.slice(prefix, before.length - suffix)) {
    const deleted = document.createElement("del");
    deleted.textContent = `${line}\n`;
    fragment.append(deleted);
  }

  for (const line of after.slice(prefix, after.length - suffix)) {
    const inserted = document.createElement("ins");
    inserted.textContent = `${line}\n`;
    fragment.append(inserted);
  }

  for (const line of before.slice(before.length - suffix)) {
    fragment.append(`${line}\n`);
  }

  block.append(fragment);
  return block;
}

interface HistoryRevision {
  readonly id: string;
  readonly bodyMd: string;
  readonly editorName: string | null;
  readonly editedAt: string;
}

interface HistoryPayload {
  readonly post: {
    readonly bodyMd: string;
    readonly editedAt: string | null;
    readonly editedByName: string | null;
  };
  readonly revisions: readonly HistoryRevision[];
}

function renderHistory(panel: HTMLElement, payload: HistoryPayload): void {
  panel.replaceChildren();
  const versions = [
    ...payload.revisions.map((revision) => ({
      label: `${revision.editorName ?? ""} · ${new Date(revision.editedAt).toLocaleString()}`,
      body: revision.bodyMd,
    })),
    {
      label:
        payload.post.editedAt === null
          ? ""
          : `${payload.post.editedByName ?? ""} · ${new Date(payload.post.editedAt).toLocaleString()}`,
      body: payload.post.bodyMd,
    },
  ];

  for (const [index, version] of versions.entries()) {
    const section = document.createElement("section");
    section.dataset.historyVersion = String(index);
    const heading = document.createElement("p");
    heading.textContent = version.label;
    section.append(heading);

    if (index > 0) {
      const previous = versions[index - 1];

      if (previous !== undefined) {
        section.append(diffLines(previous.body, version.body));
      }
    }

    panel.append(section);
  }
}

async function openHistory(button: HTMLElement): Promise<void> {
  const postId = button.dataset.postHistory ?? "";
  const panel = document.querySelector<HTMLElement>(`[data-post-history-panel="${postId}"]`);

  if (panel === null) {
    return;
  }

  if (panel.hidden === false) {
    panel.hidden = true;
    return;
  }

  const response = await fetch(`/api/posts/${postId}/history`, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    return;
  }

  renderHistory(panel, (await response.json()) as HistoryPayload);
  panel.hidden = false;
}

function topicId(): string {
  return document.querySelector<HTMLElement>("[data-topic-page]")?.dataset.topicId ?? "";
}

document.addEventListener("submit", (event) => {
  const form = event.target;

  if (
    !(form instanceof HTMLFormElement) ||
    (!form.matches("[data-new-topic-form]") &&
      !form.matches("[data-reply-form]") &&
      !form.matches("[data-edit-form]"))
  ) {
    return;
  }

  event.preventDefault();
  void submitForm(form);
});

document.addEventListener("click", (event) => {
  const target = event.target;

  if (!(target instanceof Element)) {
    return;
  }

  const quote = target.closest<HTMLElement>("[data-quote-post]");

  if (quote !== null) {
    const id = quote.dataset.quotePost ?? "";
    const selected = readQuotes(topicId());
    const next = selected.includes(id)
      ? selected.filter((candidate) => candidate !== id)
      : [...selected, id];
    writeQuotes(topicId(), next);
    markQuoteButtons(topicId());
    return;
  }

  const replyToggle = target.closest("[data-reply-toggle]");

  if (replyToggle !== null) {
    openReplyForm(topicId());
    return;
  }

  const history = target.closest<HTMLElement>("[data-post-history]");

  if (history !== null) {
    void openHistory(history);
    return;
  }

  const postAction = target.closest<HTMLElement>("[data-post-action]");

  if (postAction !== null) {
    const confirmText = postAction.dataset.confirm;

    if (confirmText !== undefined && !window.confirm(confirmText)) {
      return;
    }

    void postJson(`/api/posts/${postAction.dataset.postId ?? ""}/delete`, {
      action: postAction.dataset.postAction,
    }).then((response) => {
      if (response.ok) {
        window.location.reload();
      }
    });
    return;
  }

  const topicAction = target.closest<HTMLElement>("[data-topic-action]");

  if (topicAction !== null) {
    const confirmText = topicAction.dataset.confirm;

    if (confirmText !== undefined && !window.confirm(confirmText)) {
      return;
    }

    void postJson(`/api/topics/${topicAction.dataset.topicId ?? ""}/delete`, {
      action: topicAction.dataset.topicAction,
    }).then((response) => {
      if (response.ok) {
        window.location.assign("/");
      }
    });
  }
});

const activeTopic = topicId();

if (activeTopic !== "") {
  markQuoteButtons(activeTopic);
}
