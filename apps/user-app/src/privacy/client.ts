import { readClientSession, readLabels } from "../csrf.ts";
import type { PrivacyLabels } from "./page.ts";

interface DataRequest {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly exportExpiresAt: string | null;
}

const labels = readLabels<PrivacyLabels>("privacy-labels");

function requestText(request: DataRequest): string {
  const kind = labels?.kinds[request.kind] ?? request.kind;
  const status = labels?.statuses[request.status] ?? request.status;

  return `${kind}: ${status}`;
}

function renderRequests(requests: readonly DataRequest[]): void {
  const list = document.querySelector<HTMLElement>("[data-privacy-requests]");

  if (list === null) {
    return;
  }

  if (requests.length === 0) {
    const item = document.createElement("li");
    item.className = "bl-muted";
    item.textContent = labels?.noRequests ?? "";
    list.replaceChildren(item);
    return;
  }

  list.replaceChildren(
    ...requests.map((request) => {
      const item = document.createElement("li");
      item.dataset.privacyRequest = request.id;
      item.textContent = requestText(request);

      if (
        request.kind === "export" &&
        request.status === "completed" &&
        request.exportExpiresAt !== null &&
        new Date(request.exportExpiresAt).getTime() > Date.now()
      ) {
        const link = document.createElement("a");
        link.href = `/api/me/data-export/${request.id}`;
        link.dataset.privacyDownload = request.id;
        link.textContent = labels?.download ?? "";
        item.append(" ", link);
      }

      return item;
    }),
  );
}

async function loadRequests(): Promise<void> {
  const error = document.querySelector<HTMLElement>("[data-privacy-error]");

  if (error !== null) {
    error.hidden = true;
  }

  try {
    const response = await fetch("/api/me/data-requests", {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error("request list failed");
    }

    const body = (await response.json()) as { readonly requests: readonly DataRequest[] };
    renderRequests(body.requests);
  } catch {
    if (error !== null) {
      error.textContent = labels?.loadError ?? "";
      error.hidden = false;
    }
  }
}

async function request(kind: "export" | "erasure"): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(
    kind === "export" ? "[data-privacy-export]" : "[data-privacy-erasure]",
  );
  const status = document.querySelector<HTMLElement>("[data-privacy-status]");
  const error = document.querySelector<HTMLElement>("[data-privacy-error]");

  if (button !== null) {
    button.disabled = true;
  }

  if (status !== null) {
    status.hidden = true;
  }

  if (error !== null) {
    error.hidden = true;
  }

  try {
    const session = await readClientSession();

    if (!session.authenticated || session.csrfToken === null) {
      window.location.assign("/auth/login?return_to=%2Faccount%2Fprivacy");
      return;
    }

    const response = await fetch(
      kind === "export" ? "/api/me/data-export" : "/api/me/data-erasure",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bulletin-csrf": session.csrfToken,
        },
        body: "{}",
      },
    );

    if (!response.ok) {
      throw new Error("privacy request failed");
    }

    if (status !== null) {
      status.textContent =
        kind === "export" ? (labels?.exportRequested ?? "") : (labels?.erasureRequested ?? "");
      status.hidden = false;
    }

    await loadRequests();
  } catch {
    if (error !== null) {
      error.textContent =
        kind === "export" ? (labels?.exportError ?? "") : (labels?.erasureError ?? "");
      error.hidden = false;
    }
  } finally {
    if (button !== null) {
      button.disabled = false;
    }
  }
}

const exportButton = document.querySelector<HTMLButtonElement>("[data-privacy-export]");
const erasureButton = document.querySelector<HTMLButtonElement>("[data-privacy-erasure]");

exportButton?.addEventListener("click", () => void request("export"));
erasureButton?.addEventListener("click", () => void request("erasure"));
void loadRequests();
