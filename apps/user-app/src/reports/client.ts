import { clientCsrfToken } from "../csrf.ts";

const root = document.querySelector<HTMLElement>("[data-report-page]");

if (root !== null) {
  const reportId = root.getAttribute("data-report-id") ?? "";
  const status = root.querySelector<HTMLElement>("[data-report-action-status]");
  const statusSelect = root.querySelector<HTMLSelectElement>("[data-report-status-select]");
  const assign = root.querySelector<HTMLButtonElement>("[data-report-assign]");
  const commentForm = root.querySelector<HTMLFormElement>("[data-report-comment-form]");
  let pending = false;

  const label = (name: string): string => root.getAttribute(`data-label-${name}`) ?? "";

  const show = (message: string, error = false): void => {
    if (status === null) {
      return;
    }

    status.textContent = message;
    status.hidden = false;
    status.classList.toggle("bl-error-text", error);
  };

  const post = async (body: Record<string, unknown>): Promise<boolean> => {
    const token = await clientCsrfToken();
    const response = await fetch(`/api/reports/${encodeURIComponent(reportId)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { "x-bulletin-csrf": token }),
      },
      body: JSON.stringify(body),
    });

    return response.ok;
  };

  root
    .querySelector<HTMLButtonElement>("[data-report-status-save]")
    ?.addEventListener("click", async () => {
      if (pending || statusSelect === null) {
        return;
      }

      pending = true;
      const ok = await post({ action: "status", status: statusSelect.value });
      pending = false;

      if (ok) {
        window.location.reload();
      } else {
        show(label("failed"), true);
      }
    });

  assign?.addEventListener("click", async () => {
    if (pending) {
      return;
    }

    pending = true;
    const next = assign.getAttribute("data-assigned") !== "true";
    const ok = await post({ action: "assign", assign: next });
    pending = false;

    if (ok) {
      window.location.reload();
    } else {
      show(label("failed"), true);
    }
  });

  commentForm?.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (pending) {
      return;
    }

    const data = new FormData(commentForm);
    const body = String(data.get("body") ?? "").trim();

    if (body === "") {
      return;
    }

    pending = true;
    const ok = await post({ action: "comment", body });
    pending = false;

    if (ok) {
      window.location.reload();
    } else {
      const error = commentForm.querySelector<HTMLElement>("[data-form-error]");

      if (error !== null) {
        error.hidden = false;
      }
    }
  });
}

interface ReportTarget {
  readonly type: "post" | "member" | "pm";
  readonly id: string;
}

function reportTarget(button: HTMLElement): ReportTarget | null {
  const post = button.getAttribute("data-report-post");
  const member = button.getAttribute("data-report-member");
  const message = button.getAttribute("data-report-message");

  if (post !== null && /^\d+$/.test(post)) {
    return { type: "post", id: post };
  }

  if (member !== null && /^\d+$/.test(member)) {
    return { type: "member", id: member };
  }

  if (message !== null && /^\d+$/.test(message)) {
    return { type: "pm", id: message };
  }

  return null;
}

const reportButtons = [
  ...document.querySelectorAll<HTMLElement>(
    "[data-report-post], [data-report-member], [data-report-message]",
  ),
];
const labelsRoot = document.querySelector<HTMLElement>("[data-report-labels]");

if (reportButtons.length > 0 && labelsRoot !== null) {
  const label = (name: string): string =>
    labelsRoot.getAttribute(`data-label-report-${name}`) ?? "";
  const reasons = [
    { value: "spam", label: label("reason-spam") },
    { value: "abuse", label: label("reason-abuse") },
    { value: "harassment", label: label("reason-harassment") },
    { value: "off_topic", label: label("reason-off-topic") },
    { value: "other", label: label("reason-other") },
  ].filter((reason) => reason.label !== "");
  const dialog = document.createElement("dialog");
  dialog.className = "bl-report-dialog";
  const form = document.createElement("form");
  form.className = "bl-form";
  form.method = "dialog";

  const title = document.createElement("h2");
  title.className = "bl-card__title";
  title.textContent = label("title");

  const intro = document.createElement("p");
  intro.className = "bl-muted";
  intro.textContent = label("intro");

  const reasonLabel = document.createElement("label");
  reasonLabel.className = "bl-label";
  reasonLabel.textContent = label("reason");
  const reason = document.createElement("select");
  reason.className = "bl-input";
  reason.name = "reason";
  reason.required = true;

  for (const option of reasons) {
    const element = document.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    reason.append(element);
  }

  reasonLabel.htmlFor = "report-dialog-reason";
  reason.id = "report-dialog-reason";

  const commentLabel = document.createElement("label");
  commentLabel.className = "bl-label";
  commentLabel.textContent = label("comment");
  const comment = document.createElement("textarea");
  comment.className = "bl-input";
  comment.name = "comment";
  comment.rows = 3;
  comment.maxLength = 2_000;
  commentLabel.htmlFor = "report-dialog-comment";
  comment.id = "report-dialog-comment";

  const status = document.createElement("p");
  status.className = "bl-error-text";
  status.hidden = true;

  const actions = document.createElement("div");
  actions.className = "bl-actions";
  const submit = document.createElement("button");
  submit.className = "bl-button";
  submit.type = "submit";
  submit.textContent = label("submit");
  const cancel = document.createElement("button");
  cancel.className = "bl-button bl-button--quiet";
  cancel.type = "button";
  cancel.textContent = label("cancel");
  cancel.addEventListener("click", () => dialog.close());
  actions.append(submit, cancel);

  form.append(title, intro, reasonLabel, reason, commentLabel, comment, status, actions);
  dialog.append(form);
  document.body.append(dialog);

  let target: ReportTarget | null = null;
  let pending = false;

  for (const button of reportButtons) {
    button.addEventListener("click", () => {
      target = reportTarget(button);

      if (target === null) {
        return;
      }

      status.hidden = true;
      submit.disabled = false;
      comment.value = "";
      dialog.showModal();
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (target === null || pending) {
      return;
    }

    pending = true;
    submit.disabled = true;

    try {
      const token = await clientCsrfToken();
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === null ? {} : { "x-bulletin-csrf": token }),
        },
        body: JSON.stringify({
          targetType: target.type,
          targetId: target.id,
          reason: reason.value,
          comment: comment.value,
        }),
      });

      if (response.ok) {
        status.textContent = label("sent");
        status.hidden = false;
        status.className = "bl-note";
        submit.disabled = true;
        return;
      }

      status.textContent = response.status === 409 ? label("already") : label("failed");
      status.hidden = false;
      status.className = "bl-error-text";
    } catch {
      status.textContent = label("failed");
      status.hidden = false;
      status.className = "bl-error-text";
    } finally {
      pending = false;
      submit.disabled = false;
    }
  });
}
