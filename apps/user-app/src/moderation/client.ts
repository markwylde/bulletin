import { clientCsrfToken } from "../csrf.ts";

const root = document.querySelector<HTMLElement>("[data-moderation-queue]");

if (root !== null) {
  const checks = [...root.querySelectorAll<HTMLInputElement>("[data-moderation-check]")];
  const approve = root.querySelector<HTMLButtonElement>("[data-moderation-approve]");
  const reject = root.querySelector<HTMLButtonElement>("[data-moderation-reject]");
  const selectAll = root.querySelector<HTMLInputElement>("[data-moderation-select-all]");
  const status = root.querySelector<HTMLElement>("[data-moderation-status]");
  const count = root.querySelector<HTMLElement>("[data-moderation-count]");
  const empty = root.querySelector<HTMLElement>("[data-moderation-empty]");
  const list = root.querySelector<HTMLElement>("[data-moderation-list]");
  let pending = false;

  const selected = (): readonly string[] =>
    checks
      .filter((check) => check.checked && check.closest("[data-moderation-item]") !== null)
      .map((check) => check.value);

  const refresh = (): void => {
    const ids = selected();
    const disabled = pending || ids.length === 0;

    if (approve !== null) {
      approve.disabled = disabled;
    }

    if (reject !== null) {
      reject.disabled = disabled;
    }

    if (status !== null && ids.length === 0 && !pending) {
      status.hidden = true;
    }
  };

  const showStatus = (message: string, error = false): void => {
    if (status === null) {
      return;
    }

    status.textContent = message;
    status.hidden = false;
    status.classList.toggle("bl-error-text", error);
  };

  const label = (name: string): string => root.getAttribute(`data-label-${name}`) ?? "";

  const submit = async (action: "approve" | "reject"): Promise<void> => {
    const postIds = selected();

    if (postIds.length === 0 || pending) {
      return;
    }

    pending = true;
    refresh();

    try {
      const token = await clientCsrfToken();
      const response = await fetch("/api/moderation/actions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === null ? {} : { "x-bulletin-csrf": token }),
        },
        body: JSON.stringify({ action, postIds }),
      });

      if (!response.ok) {
        showStatus(label("failed"), true);
        return;
      }

      for (const postId of postIds) {
        root.querySelector(`[data-moderation-item="${CSS.escape(postId)}"]`)?.remove();
      }

      if (list !== null && list.querySelector("[data-moderation-item]") === null) {
        list.hidden = true;

        if (empty !== null) {
          empty.hidden = false;
        }
      }

      showStatus(label(action === "approve" ? "approved" : "rejected"));
      await refreshCount();
    } catch {
      showStatus(label("failed"), true);
    } finally {
      pending = false;
      refresh();
    }
  };

  const refreshCount = async (): Promise<void> => {
    try {
      const response = await fetch("/api/moderation/count", {
        headers: { accept: "application/json" },
        cache: "no-store",
      });

      if (!response.ok) {
        return;
      }

      const body = (await response.json()) as { count?: unknown };

      if (typeof body.count === "number" && count !== null) {
        count.textContent = String(Math.max(0, body.count));
      }
    } catch {
      // A live count is an enhancement; the next poll or reload retries.
    }
  };

  for (const check of checks) {
    check.addEventListener("change", refresh);
  }

  selectAll?.addEventListener("change", () => {
    for (const check of checks) {
      check.checked = selectAll.checked;
    }

    refresh();
  });

  approve?.addEventListener("click", () => void submit("approve"));
  reject?.addEventListener("click", () => void submit("reject"));

  refresh();
  root.dataset.moderationReady = "true";
  window.setInterval(() => void refreshCount(), 3_000);
}
