import { clientCsrfToken, readLabels } from "../csrf.ts";

interface Labels {
  readonly ignoreAdd: string;
  readonly ignoreRemove: string;
  readonly error: string;
  readonly unignorable: string;
}

interface RelationshipState {
  readonly friendState: "none" | "pending_out" | "pending_in" | "friends";
  readonly ignoring: boolean;
  readonly canIgnore: boolean;
  readonly self: boolean;
}

const labels = readLabels<Labels>("profile-relationship-labels");
const actions = document.querySelector<HTMLElement>("[data-member-actions]");
const error = document.querySelector<HTMLElement>("[data-member-action-error]");
const memberId = actions?.getAttribute("data-member-id") ?? "";

function button(name: string): HTMLButtonElement | null {
  return actions?.querySelector<HTMLButtonElement>(`[data-${name}]`) ?? null;
}

function show(name: string, visible: boolean): void {
  const element = button(name);

  if (element !== null) {
    element.hidden = !visible;
  }
}

function showError(message: string | undefined): void {
  if (error !== null) {
    error.textContent = message ?? labels?.error ?? "";
    error.hidden = false;
  }
}

function applyState(state: RelationshipState): void {
  if (actions === null) {
    return;
  }

  if (state.self) {
    actions.hidden = true;
    return;
  }

  actions.hidden = false;
  show("friend-request", state.friendState === "none");
  show("friend-pending", state.friendState === "pending_out");
  show("friend-accept", state.friendState === "pending_in");
  show("friend-decline", state.friendState === "pending_in");
  show("friend-remove", state.friendState === "friends");
  show("ignore-toggle", state.canIgnore);

  const ignore = button("ignore-toggle");

  if (ignore !== null) {
    ignore.textContent = state.ignoring ? (labels?.ignoreRemove ?? "") : (labels?.ignoreAdd ?? "");
    ignore.setAttribute("data-ignoring", state.ignoring ? "true" : "false");
  }
}

async function load(): Promise<void> {
  if (
    actions === null ||
    memberId === "" ||
    document.documentElement.dataset.visitor !== "member"
  ) {
    return;
  }

  try {
    const response = await fetch(
      `/api/relationships/state?memberId=${encodeURIComponent(memberId)}`,
      { headers: { accept: "application/json" } },
    );

    if (!response.ok) {
      return;
    }

    applyState((await response.json()) as RelationshipState);
  } catch {
    // The actions are an enhancement; the profile itself still renders.
  }
}

async function post(path: string, body: Record<string, unknown>): Promise<void> {
  try {
    const token = await clientCsrfToken();

    if (token === null) {
      window.location.assign(
        `/auth/login?return_to=${encodeURIComponent(window.location.pathname)}`,
      );
      return;
    }

    const response = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bulletin-csrf": token,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as { readonly code?: string };
      showError(result.code === "unignorable" ? labels?.unignorable : labels?.error);
      return;
    }

    if (error !== null) {
      error.hidden = true;
    }

    await load();
  } catch {
    showError(labels?.error);
  }
}

button("friend-request")?.addEventListener("click", () => {
  void post("/api/friends", { action: "request", memberId });
});
button("friend-accept")?.addEventListener("click", () => {
  void post("/api/friends", { action: "accept", requesterId: memberId });
});
button("friend-decline")?.addEventListener("click", () => {
  void post("/api/friends", { action: "decline", requesterId: memberId });
});
button("friend-remove")?.addEventListener("click", () => {
  void post("/api/friends", { action: "remove", memberId });
});
button("ignore-toggle")?.addEventListener("click", () => {
  const ignoring = button("ignore-toggle")?.getAttribute("data-ignoring") === "true";
  void post("/api/ignores", { memberId, ignoring: !ignoring });
});

void load();
