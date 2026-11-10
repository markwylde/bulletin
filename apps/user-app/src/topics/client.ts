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

function choiceRow(label: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "bl-poll-builder__choice";
  row.dataset.pollChoiceRow = "true";
  const input = document.createElement("input");
  input.className = "bl-input";
  input.type = "text";
  input.dataset.pollChoiceLabel = "true";
  input.placeholder = label;
  input.maxLength = 300;
  const remove = document.createElement("button");
  remove.className = "bl-button bl-button--quiet bl-button--small";
  remove.type = "button";
  remove.textContent = "×";
  remove.dataset.pollRemoveChoice = "true";
  remove.addEventListener("click", () => row.remove());
  row.append(input, remove);
  return row;
}

function addQuestion(builder: HTMLElement): void {
  const container = builder.querySelector<HTMLElement>("[data-poll-questions]");
  const labels = builder.dataset;

  if (container === null) {
    return;
  }

  const question = document.createElement("fieldset");
  question.className = "bl-poll-builder__question";
  question.dataset.pollQuestionRow = "true";
  const legend = document.createElement("legend");
  legend.textContent = labels.labelQuestion ?? "";
  const prompt = document.createElement("input");
  prompt.className = "bl-input";
  prompt.type = "text";
  prompt.dataset.pollPrompt = "true";
  prompt.placeholder = labels.labelQuestion ?? "";
  prompt.maxLength = 500;
  const multipleLabel = document.createElement("label");
  multipleLabel.className = "bl-check";
  const multiple = document.createElement("input");
  multiple.type = "checkbox";
  multiple.dataset.pollMultiple = "true";
  multipleLabel.append(multiple, ` ${labels.labelMultiple ?? ""}`);
  const choices = document.createElement("div");
  choices.dataset.pollChoices = "true";
  choices.append(choiceRow(labels.labelChoice ?? ""), choiceRow(labels.labelChoice ?? ""));
  const addChoice = document.createElement("button");
  addChoice.className = "bl-button bl-button--quiet bl-button--small";
  addChoice.type = "button";
  addChoice.textContent = labels.labelAddChoice ?? "";
  addChoice.addEventListener("click", () => {
    choices.append(choiceRow(labels.labelChoice ?? ""));
  });
  const remove = document.createElement("button");
  remove.className = "bl-button bl-button--quiet bl-button--small";
  remove.type = "button";
  remove.textContent = labels.labelRemove ?? "";
  remove.addEventListener("click", () => question.remove());
  question.append(legend, prompt, multipleLabel, choices, addChoice, remove);
  container.append(question);
}

function collectPoll(form: HTMLFormElement): Record<string, unknown> | null {
  const builder = form.querySelector<HTMLElement>("[data-poll-builder]");

  if (builder === null) {
    return null;
  }

  const questions = [...builder.querySelectorAll<HTMLElement>("[data-poll-question-row]")]
    .map((question) => ({
      prompt: question.querySelector<HTMLInputElement>("[data-poll-prompt]")?.value.trim() ?? "",
      multiple: question.querySelector<HTMLInputElement>("[data-poll-multiple]")?.checked === true,
      choices: [...question.querySelectorAll<HTMLElement>("[data-poll-choice-row]")]
        .map((choice) => ({
          label:
            choice.querySelector<HTMLInputElement>("[data-poll-choice-label]")?.value.trim() ?? "",
        }))
        .filter((choice) => choice.label !== ""),
    }))
    .filter((question) => question.prompt !== "" && question.choices.length >= 2);

  if (questions.length === 0) {
    return null;
  }

  const closesAt = form.querySelector<HTMLInputElement>("input[name=pollClosesAt]")?.value ?? "";
  const resultsVisible =
    form.querySelector<HTMLInputElement>("input[name=pollResultsVisible]")?.checked === true;

  return {
    questions,
    closesAt: closesAt === "" ? null : new Date(closesAt).toISOString(),
    resultsVisibleBeforeVoting: resultsVisible,
  };
}

async function submitForm(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const bodyMd = data.get("bodyMd");
  const button = submitButton(form);
  const poll = form.matches("[data-new-topic-form]") ? collectPoll(form) : null;
  const request = form.matches("[data-new-topic-form]")
    ? postJson(`/api/forums/${form.dataset.forumId ?? ""}/topics`, {
        title: String(data.get("title") ?? ""),
        bodyMd: String(bodyMd ?? ""),
        ...(String(data.get("prefixId") ?? "") === ""
          ? {}
          : { prefixId: String(data.get("prefixId")) }),
        ...(poll === null ? {} : { poll }),
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

  if (versions.length === 0) {
    return;
  }

  const controls = document.createElement("div");
  controls.className = "bl-actions";
  const from = document.createElement("select");
  from.className = "bl-input";
  from.dataset.historyFrom = "true";
  from.setAttribute("aria-label", panel.dataset.labelFrom ?? "");
  const to = document.createElement("select");
  to.className = "bl-input";
  to.dataset.historyTo = "true";
  to.setAttribute("aria-label", panel.dataset.labelTo ?? "");

  for (const [index, version] of versions.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${panel.dataset.labelVersion ?? ""} ${index + 1}: ${version.label}`;
    from.append(option);
    to.append(option.cloneNode(true));
  }

  from.value = "0";
  to.value = String(versions.length - 1);
  const diff = document.createElement("div");
  diff.dataset.historyDiff = "true";
  const update = (): void => {
    const before = versions[Number(from.value)]?.body ?? "";
    const after = versions[Number(to.value)]?.body ?? "";
    diff.replaceChildren(diffLines(before, after));
  };

  from.addEventListener("change", update);
  to.addEventListener("change", update);
  controls.append(from, to);
  diff.append(diffLines(versions[0]?.body ?? "", versions[versions.length - 1]?.body ?? ""));
  panel.append(controls, diff);

  for (const [index, version] of versions.entries()) {
    const details = document.createElement("details");
    details.dataset.historyVersion = String(index);
    const summary = document.createElement("summary");
    summary.textContent = `${panel.dataset.labelVersion ?? ""} ${index + 1}: ${version.label}`;
    const body = document.createElement("pre");
    body.className = "bl-diff";
    body.textContent = version.body;
    details.append(summary, body);
    panel.append(details);
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

  const addQuestionButton = target.closest("[data-poll-add-question]");

  if (addQuestionButton !== null) {
    const builder = addQuestionButton.closest<HTMLElement>("[data-poll-builder]");

    if (builder !== null) {
      addQuestion(builder);
    }

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
interface EditablePost {
  readonly postId: string;
  readonly bodyMd?: string;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly canRedact: boolean;
}

function privatePostControls(post: EditablePost): void {
  const article = document.querySelector<HTMLElement>(`[data-post="${post.postId}"]`);

  if (article === null) {
    return;
  }

  const labels = article.dataset;

  if (post.canEdit && post.bodyMd !== undefined) {
    const existing = article.querySelector("[data-post-edit]");

    if (existing === null) {
      const details = document.createElement("details");
      details.className = "bl-post__edit";
      details.dataset.postEdit = post.postId;
      const summary = document.createElement("summary");
      summary.textContent = labels.labelEdit ?? "";
      const form = document.createElement("form");
      form.className = "bl-topic-form";
      form.dataset.editForm = "true";
      form.dataset.postId = post.postId;
      const label = document.createElement("label");
      label.className = "bl-label";
      label.htmlFor = `edit-body-${post.postId}`;
      label.textContent = labels.labelBody ?? "";
      const textarea = document.createElement("textarea");
      textarea.className = "bl-input";
      textarea.id = `edit-body-${post.postId}`;
      textarea.name = "bodyMd";
      textarea.rows = 6;
      textarea.required = true;
      textarea.value = post.bodyMd;
      form.append(label, textarea);

      if (post.canRedact) {
        const redactLabel = document.createElement("label");
        redactLabel.className = "bl-check";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.name = "redact";
        checkbox.checked = true;
        redactLabel.append(checkbox, ` ${labels.labelRedact ?? ""}`);
        form.append(redactLabel);
      }

      const submit = document.createElement("button");
      submit.className = "bl-button";
      submit.type = "submit";
      submit.dataset.editSubmit = "true";
      submit.textContent = labels.labelSave ?? "";
      const error = document.createElement("p");
      error.className = "bl-error-text";
      error.dataset.formError = "true";
      error.hidden = true;
      error.textContent = labels.labelEditFailed ?? "";
      form.append(submit, error);
      details.append(summary, form);
      const main = article.querySelector(".bl-post__main");
      const history = main?.querySelector("[data-post-history-panel]") ?? null;

      if (main !== null) {
        if (history !== null) {
          main.insertBefore(details, history);
        } else {
          main.append(details);
        }
      }
    }
  }

  if (post.canDelete && article.querySelector('[data-post-action="soft"]') === null) {
    const actions = article.querySelector(".bl-post__meta");

    if (actions !== null) {
      const button = document.createElement("button");
      button.className = "bl-button bl-button--quiet bl-button--small";
      button.type = "button";
      button.dataset.postAction = "soft";
      button.dataset.postId = post.postId;
      button.dataset.confirm = labels.labelConfirmDelete ?? "";
      button.textContent = labels.labelDelete ?? "";
      actions.append(button);
    }
  }
}

window.addEventListener("bulletin:editable-posts", (event) => {
  const posts = (event as CustomEvent<readonly EditablePost[]>).detail;

  if (!Array.isArray(posts)) {
    return;
  }

  for (const post of posts) {
    privatePostControls(post);
  }
});
