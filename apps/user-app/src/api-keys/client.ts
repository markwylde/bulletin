import { readClientSession } from "../csrf.ts";

interface Labels {
  readonly prefix: string;
  readonly scopes: string;
  readonly created: string;
  readonly lastUsed: string;
  readonly expires: string;
  readonly revoked: string;
  readonly revoke: string;
  readonly revoking: string;
  readonly empty: string;
  readonly loadError: string;
  readonly createFailed: string;
  readonly revokeFailed: string;
  readonly createdMessage: string;
  readonly revokedMessage: string;
  readonly invalid: string;
}

interface Config {
  readonly labels: Labels;
  readonly scopeLabels: Readonly<Record<string, string>>;
  readonly scopes: readonly string[];
}

interface ApiKey {
  readonly id: string;
  readonly prefix: string;
  readonly label: string;
  readonly kind: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
}

interface KeysResponse {
  readonly keys: readonly ApiKey[];
  readonly scopes: readonly string[];
}

function readConfig(): Config | null {
  const element = document.getElementById("api-keys-config");

  if (element?.textContent === null || element?.textContent === undefined) {
    return null;
  }

  try {
    return JSON.parse(element.textContent) as Config;
  } catch {
    return null;
  }
}

const config = readConfig();
const list = document.querySelector<HTMLElement>("[data-api-keys-list]");
const empty = document.querySelector<HTMLElement>("[data-api-keys-empty]");
const loading = document.querySelector<HTMLElement>("[data-api-keys-loading]");
const loadError = document.querySelector<HTMLElement>("[data-api-keys-error]");
const form = document.querySelector<HTMLFormElement>("[data-api-key-form]");
const scopesField = document.querySelector<HTMLElement>("[data-api-key-scopes]");
const labelInput = document.querySelector<HTMLInputElement>("[data-api-key-label]");
const expiryInput = document.querySelector<HTMLInputElement>("[data-api-key-expiry]");
const submit = document.querySelector<HTMLButtonElement>("[data-api-key-submit]");
const formError = document.querySelector<HTMLElement>("[data-api-key-error]");
const secretBox = document.querySelector<HTMLElement>("[data-api-key-secret]");
const secretValue = document.querySelector<HTMLElement>("[data-api-key-secret-value]");
const message = document.querySelector<HTMLElement>("[data-api-key-message]");

function showError(element: HTMLElement | null, text: string): void {
  if (element !== null) {
    element.textContent = text;
    element.hidden = text === "";
  }
}

function formatDate(value: string | null): string {
  return value === null ? "—" : new Date(value).toLocaleString();
}

function scopeText(scopes: readonly string[]): string {
  return scopes.map((scope) => config?.scopeLabels[scope] ?? scope).join(", ");
}

function renderKeys(keys: readonly ApiKey[]): void {
  if (list === null) {
    return;
  }

  list.replaceChildren();

  for (const key of keys) {
    const item = document.createElement("li");
    item.className = "bl-api-key";
    item.dataset.apiKeyRow = key.id;

    const title = document.createElement("strong");
    title.textContent = `blt_${key.prefix}_…`;
    item.append(title);

    const label = document.createElement("span");
    label.className = "bl-muted";
    label.textContent = ` · ${key.label}`;
    item.append(label);

    const details = document.createElement("p");
    details.className = "bl-muted";
    details.textContent = [
      `${config?.labels.scopes ?? ""}: ${scopeText(key.scopes)}`,
      `${config?.labels.created ?? ""}: ${formatDate(key.createdAt)}`,
      `${config?.labels.lastUsed ?? ""}: ${formatDate(key.lastUsedAt)}`,
      `${config?.labels.expires ?? ""}: ${formatDate(key.expiresAt)}`,
    ].join(" · ");
    item.append(details);

    if (key.revokedAt !== null) {
      const revoked = document.createElement("span");
      revoked.className = "bl-muted";
      revoked.textContent = ` ${config?.labels.revoked ?? ""}`;
      item.append(revoked);
    } else {
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "bl-button bl-button--quiet";
      revoke.dataset.apiKeyRevoke = key.id;
      revoke.textContent = config?.labels.revoke ?? "";
      revoke.addEventListener("click", () => {
        void revokeKey(key.id, revoke);
      });
      item.append(revoke);
    }

    list.append(item);
  }

  if (empty !== null) {
    empty.hidden = keys.length !== 0;
  }
}

async function loadKeys(): Promise<void> {
  if (config === null) {
    return;
  }

  try {
    const response = await fetch("/api/me/api-keys", {
      credentials: "include",
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error("load failed");
    }

    const body = (await response.json()) as KeysResponse;
    renderKeys(body.keys);
    if (loading !== null) {
      loading.hidden = true;
    }
    showError(loadError, "");
  } catch {
    if (loading !== null) {
      loading.hidden = true;
    }
    showError(loadError, config.labels.loadError);
  }
}

async function csrf(): Promise<string | null> {
  const session = await readClientSession();

  if (!session.authenticated || session.csrfToken === null) {
    window.location.assign("/auth/login?return_to=%2Faccount%2Fapi-keys");
    return null;
  }

  return session.csrfToken;
}

async function revokeKey(id: string, button: HTMLButtonElement): Promise<void> {
  if (config === null) {
    return;
  }

  button.disabled = true;
  button.textContent = config.labels.revoking;

  try {
    const token = await csrf();

    if (token === null) {
      return;
    }

    const response = await fetch("/api/me/api-keys/revoke", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "x-bulletin-csrf": token },
      body: JSON.stringify({ id }),
    });

    if (!response.ok) {
      throw new Error("revoke failed");
    }

    if (message !== null) {
      message.textContent = config.labels.revokedMessage;
      message.hidden = false;
    }

    await loadKeys();
  } catch {
    button.disabled = false;
    button.textContent = config.labels.revoke;
    showError(formError, config.labels.revokeFailed);
  }
}

for (const scope of config?.scopes ?? []) {
  if (scopesField === null) {
    continue;
  }

  const label = document.createElement("label");
  label.className = "bl-checkbox";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = "scope";
  input.value = scope;
  input.checked = scope === "read:forums";
  input.dataset.apiKeyScope = scope;
  const text = document.createElement("span");
  text.textContent = config?.scopeLabels[scope] ?? scope;
  label.append(input, text);
  scopesField.append(label);
}

form?.addEventListener("submit", (event) => {
  event.preventDefault();

  if (config === null || submit === null) {
    return;
  }

  void (async () => {
    submit.disabled = true;
    showError(formError, "");

    const scopes = [
      ...document.querySelectorAll<HTMLInputElement>("[data-api-key-scope]:checked"),
    ].map((input) => input.value);
    const expiry = expiryInput?.value ?? "";

    if (scopes.length === 0 || (labelInput?.value.trim().length ?? 0) < 1) {
      showError(formError, config.labels.invalid);
      submit.disabled = false;
      return;
    }

    try {
      const token = await csrf();

      if (token === null) {
        return;
      }

      const response = await fetch("/api/me/api-keys", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-bulletin-csrf": token },
        body: JSON.stringify({
          label: labelInput?.value ?? "",
          scopes,
          ...(expiry === "" ? {} : { expiresAt: `${expiry}T00:00:00.000Z` }),
        }),
      });

      if (!response.ok) {
        throw new Error("create failed");
      }

      const body = (await response.json()) as { readonly key: string };
      if (secretValue !== null) {
        secretValue.textContent = body.key;
      }
      if (secretBox !== null) {
        secretBox.hidden = false;
      }
      if (message !== null) {
        message.textContent = config.labels.createdMessage;
        message.hidden = false;
      }
      if (form !== null) {
        form.reset();
      }
      await loadKeys();
    } catch {
      showError(formError, config.labels.createFailed);
    } finally {
      submit.disabled = false;
    }
  })();
});

void loadKeys();
