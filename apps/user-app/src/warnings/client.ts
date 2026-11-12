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

const memberPage = document.querySelector<HTMLElement>("[data-warnings-page]");
const ackButton = memberPage?.querySelector<HTMLButtonElement>("[data-warning-ack-button]");

ackButton?.addEventListener("click", async () => {
  const error = memberPage?.querySelector<HTMLElement>("[data-warning-ack-error]");
  ackButton.disabled = true;

  try {
    if ((await postJson("/api/me/warnings/ack", {})).ok) {
      window.location.reload();
      return;
    }
  } catch {
    // Fall through to the visible error.
  }

  if (error !== null && error !== undefined) {
    error.hidden = false;
  }

  ackButton.disabled = false;
});

const staffPage = document.querySelector<HTMLElement>("[data-staff-warnings-page]");
const issueForm = staffPage?.querySelector<HTMLFormElement>("[data-warning-issue-form]");
const reasonSelect = staffPage?.querySelector<HTMLSelectElement>("[data-warning-reason]");
const pointsInput = staffPage?.querySelector<HTMLInputElement>("[data-warning-points]");
const expiryInput = staffPage?.querySelector<HTMLInputElement>("[data-warning-expiry]");

function applyReasonDefaults(): void {
  if (reasonSelect === null || reasonSelect === undefined) {
    return;
  }

  const option = reasonSelect.selectedOptions[0];

  if (option === undefined) {
    return;
  }

  if (pointsInput !== null && pointsInput !== undefined) {
    pointsInput.value = option.getAttribute("data-points") ?? "0";
    pointsInput.disabled = option.getAttribute("data-override") !== "true";
  }

  if (expiryInput !== null && expiryInput !== undefined) {
    expiryInput.value = option.getAttribute("data-expiry") ?? "30";
  }
}

reasonSelect?.addEventListener("change", applyReasonDefaults);
applyReasonDefaults();

issueForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const memberId = form.getAttribute("data-member-id") ?? "";
  const submit = form.querySelector<HTMLButtonElement>("[data-warning-issue-submit]");
  const error = form.querySelector<HTMLElement>("[data-form-error]");

  if (submit !== null) {
    submit.disabled = true;
  }

  try {
    const response = await postJson("/api/moderation/warnings", {
      memberId,
      reasonId: String(data.get("reasonId") ?? ""),
      points: Number(data.get("points") ?? 0),
      expiryDays: Number(data.get("expiryDays") ?? 30),
      memberNote: String(data.get("memberNote") ?? ""),
      staffNote: String(data.get("staffNote") ?? ""),
      ackRequired: data.get("ackRequired") === "on",
      ...(new URLSearchParams(window.location.search).get("post") === null
        ? {}
        : {
            contentType: "post",
            contentId: new URLSearchParams(window.location.search).get("post"),
          }),
    });

    if (response.ok) {
      window.location.reload();
      return;
    }
  } catch {
    // Fall through to the visible error.
  }

  if (error !== null) {
    error.hidden = false;
  }

  if (submit !== null) {
    submit.disabled = false;
  }
});

if (memberPage !== null) {
  memberPage.dataset.warningsReady = "true";
}

if (staffPage !== null) {
  staffPage.dataset.warningsReady = "true";
}

for (const row of staffPage?.querySelectorAll<HTMLElement>("[data-warning-revoke]") ?? []) {
  const warningId = row.getAttribute("data-warning-revoke") ?? "";
  const input = row.querySelector<HTMLInputElement>("[data-warning-revoke-reason]");
  const button = row.querySelector<HTMLButtonElement>("[data-warning-revoke-button]");

  button?.addEventListener("click", async () => {
    const reason = input?.value.trim() ?? "";

    if (reason === "" || button.disabled) {
      return;
    }

    button.disabled = true;

    try {
      const response = await postJson(`/api/warnings/${warningId}/revoke`, { reason });

      if (response.ok) {
        window.location.reload();
        return;
      }
    } catch {
      // Re-enable below.
    }

    button.disabled = false;
  });
}
