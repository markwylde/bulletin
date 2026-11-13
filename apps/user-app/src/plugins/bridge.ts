import { BRIDGE_INIT, createHostBridge } from "@bulletin/plugin-sdk/bridge";

/**
 * Host page half of the plugin iframe bridge (ADR 0009, 0010). Each `<bl-plugin-app>` gets
 * its own iframe, MessageChannel and random instance token. The host never listens for
 * `window` messages, so another frame cannot spoof a call by posting to the page.
 */

const BRIDGE_MESSAGE_LIMIT = 50;
const MAX_HEIGHT = 4_000;

interface AppElement extends HTMLElement {
  readonly dataset: DOMStringMap & {
    readonly pluginId?: string;
    readonly version?: string;
    readonly app?: string;
    readonly view?: string;
    readonly origin?: string;
  };
}

function pluginOrigin(element: AppElement): string {
  if (element.dataset.origin !== undefined) {
    return element.dataset.origin.replace(/\/+$/, "");
  }

  const current = new URL(window.location.href);
  current.hostname = current.hostname.startsWith("plugins.")
    ? current.hostname
    : `plugins.${current.hostname}`;
  current.pathname = "";
  current.search = "";
  current.hash = "";
  return current.origin;
}

function readView(element: AppElement): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(element.dataset.view ?? "{}");
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function csrf(): Promise<string | null> {
  try {
    const response = await fetch("/api/auth/session", { headers: { accept: "application/json" } });
    const body = (await response.json()) as { csrfToken?: unknown };
    return typeof body.csrfToken === "string" ? body.csrfToken : null;
  } catch {
    return null;
  }
}

async function mount(element: AppElement): Promise<void> {
  const pluginId = element.dataset.pluginId;
  const app = element.dataset.app;

  if (pluginId === undefined || app === undefined) {
    return;
  }

  const version = element.dataset.version ?? "1";
  const origin = pluginOrigin(element);
  const view = readView(element);
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts allow-forms");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("title", `${pluginId} app`);
  frame.dataset.pluginFrame = pluginId;
  frame.style.width = "100%";
  frame.style.border = "0";
  frame.style.display = "block";

  const channel = new MessageChannel();

  frame.addEventListener("load", () => {
    const token = crypto.randomUUID();
    const instance = createHostBridge(
      token,
      {
        read: () => view,
        route: async (path, method, body) => {
          const target = new URL(`/api/plugins/${pluginId}/bridge`, window.location.origin);
          target.searchParams.set("path", path);
          target.searchParams.set("method", method);
          const csrfToken = await csrf();
          const response = await fetch(target, {
            method: "POST",
            headers: {
              "content-type": "text/plain",
              ...(csrfToken === null ? {} : { "x-bulletin-csrf": csrfToken }),
            },
            body: body ?? "",
          });

          if (!response.ok) {
            throw new Error(`bridge route failed: ${String(response.status)}`);
          }

          const responseBody = await response.text();
          frame.dataset.bridgeRouted = "1";
          frame.dataset.bridgeBody = responseBody;
          return { status: response.status, body: responseBody };
        },
        open: (url) => {
          window.open(url, "_blank", "noopener,noreferrer");
        },
        toast: (messageKey) => {
          document.dispatchEvent(new CustomEvent("bulletin:toast", { detail: { messageKey } }));
        },
        resize: (height) => {
          frame.dataset.bridgeHeight = String(Math.min(height, MAX_HEIGHT));
          frame.style.height = `${String(Math.min(height, MAX_HEIGHT))}px`;
        },
        report: () => undefined,
      },
      { messagesPerSecond: BRIDGE_MESSAGE_LIMIT },
    );

    frame.contentWindow?.postMessage({ type: BRIDGE_INIT, token }, "*", [channel.port2]);
    channel.port1.onmessage = (event) => {
      void instance.handle(event.data);
    };
  });

  frame.src = `${origin}/apps/${pluginId}/${version}/${app}`;
  element.replaceChildren(frame);
}

function boot(): void {
  for (const element of document.querySelectorAll<AppElement>(
    "bl-plugin-app[data-plugin-id][data-app]",
  )) {
    void mount(element);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
