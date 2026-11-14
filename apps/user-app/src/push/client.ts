import { memberFetch } from "../auth/client.ts";
import { clientCsrfToken } from "../csrf.ts";

interface PushDevice {
  readonly id: string;
  readonly label: string | null;
  readonly browserFamily: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

interface PushConfig {
  readonly publicKey: string;
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(`${padded}${"=".repeat((4 - (padded.length % 4)) % 4)}`);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function dateLabel(template: string, value: string | null): string {
  if (value === null) {
    return "";
  }

  const date = new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

  return template.replace("__DATE__", date);
}

function platformLabel(): string | null {
  const navigatorWithHints = navigator as Navigator & {
    readonly userAgentData?: { readonly platform?: string };
  };
  const platform = navigatorWithHints.userAgentData?.platform?.trim();

  return platform === undefined || platform === "" ? null : platform;
}

const root = document.querySelector<HTMLElement>("[data-push-settings]");

if (root !== null) {
  const labels = root.dataset;
  const status = root.querySelector<HTMLElement>("[data-push-status]");
  const error = root.querySelector<HTMLElement>("[data-push-error]");
  const enable = root.querySelector<HTMLButtonElement>("[data-push-enable]");
  const list = root.querySelector<HTMLElement>("[data-push-devices]");
  const empty = root.querySelector<HTMLElement>("[data-push-empty]");
  const supported =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  const setStatus = (text: string, show = true): void => {
    if (status !== null) {
      status.textContent = text;
      status.hidden = !show;
    }
  };

  const setError = (show: boolean): void => {
    if (error !== null) {
      error.hidden = !show;
    }
  };

  const renderDevices = (devices: readonly PushDevice[]): void => {
    if (list === null) {
      return;
    }

    list.replaceChildren();

    for (const device of devices) {
      const item = document.createElement("li");
      item.className = "bl-device-list__item";
      item.dataset.pushDevice = device.id;
      const details = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = device.label ?? labels.labelUnknownDevice ?? "";
      const browser = document.createElement("span");
      browser.className = "bl-device-list__meta";
      browser.textContent = device.browserFamily;
      const created = document.createElement("span");
      created.className = "bl-device-list__meta";
      created.textContent = dateLabel(labels.labelCreated ?? "", device.createdAt);
      const used = document.createElement("span");
      used.className = "bl-device-list__meta";
      used.textContent =
        device.lastUsedAt === null
          ? (labels.labelNeverUsed ?? "")
          : dateLabel(labels.labelLastUsed ?? "", device.lastUsedAt);
      details.append(name, browser, created, used);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "bl-button bl-button--quiet bl-button--small";
      remove.dataset.pushRemove = device.id;
      remove.textContent = labels.labelRemove ?? "";
      item.append(details, remove);
      list.append(item);
    }

    if (empty !== null) {
      empty.hidden = devices.length > 0;
    }
  };

  const loadDevices = async (): Promise<void> => {
    try {
      const response = await fetch("/api/push/devices", {
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        setError(true);
        return;
      }

      const body = (await response.json()) as { devices?: readonly PushDevice[] };
      renderDevices(body.devices ?? []);
      setError(false);
    } catch {
      setError(true);
    }
  };

  const saveSubscription = async (subscription: PushSubscription): Promise<boolean> => {
    const token = await clientCsrfToken();
    const json = subscription.toJSON();
    const response = await memberFetch("/api/push/subscribe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { "x-bulletin-csrf": token }),
      },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        keys: json.keys,
        ...(platformLabel() === null ? {} : { label: platformLabel() }),
      }),
    });

    return response.ok;
  };

  const enableHere = async (): Promise<void> => {
    if (enable === null) {
      return;
    }

    enable.disabled = true;
    setStatus(labels.labelEnabling ?? "");
    setError(false);

    try {
      const response = await fetch("/api/push/config", {
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        setError(true);
        return;
      }

      const config = (await response.json()) as PushConfig;
      const permission = await Notification.requestPermission();

      if (permission !== "granted") {
        setStatus(labels.labelPermissionDenied ?? "");
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlBytes(config.publicKey),
        }));

      if (!(await saveSubscription(subscription))) {
        setStatus(labels.labelEnableFailed ?? "");
        return;
      }

      setStatus(labels.labelEnabled ?? "");
      await loadDevices();
    } catch {
      setStatus(labels.labelEnableFailed ?? "");
    } finally {
      enable.disabled = false;
    }
  };

  const removeDevice = async (button: HTMLButtonElement, id: string): Promise<void> => {
    button.disabled = true;
    button.textContent = labels.labelRemoving ?? "";
    const token = await clientCsrfToken();

    try {
      const response = await memberFetch("/api/push/devices/delete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === null ? {} : { "x-bulletin-csrf": token }),
        },
        body: JSON.stringify({ deviceId: id }),
      });

      if (!response.ok) {
        setStatus(labels.labelRemoveFailed ?? "");
        button.disabled = false;
        button.textContent = labels.labelRemove ?? "";
        return;
      }

      setStatus(labels.labelRemoved ?? "");
      await loadDevices();
    } catch {
      setStatus(labels.labelRemoveFailed ?? "");
      button.disabled = false;
      button.textContent = labels.labelRemove ?? "";
    }
  };

  if (!supported) {
    setStatus(labels.labelUnsupported ?? "");
  } else {
    if (enable !== null) {
      enable.hidden = false;
    }

    enable?.addEventListener("click", () => {
      void enableHere();
    });
    list?.addEventListener("click", (event) => {
      const target = event.target;

      if (!(target instanceof Element)) {
        return;
      }

      const button = target.closest<HTMLButtonElement>("[data-push-remove]");

      if (button !== null && button.dataset.pushRemove !== undefined) {
        void removeDevice(button, button.dataset.pushRemove);
      }
    });
    void loadDevices();
  }
}
