/**
 * Browser bridge protocol between the forum page and a sandboxed plugin iframe (ADR 0009).
 *
 * Sandboxed frames have an opaque `"null"` origin, so the host cannot identify them by
 * origin. Each iframe gets its own `MessageChannel` and random instance token instead; only
 * messages on that private port carrying that token are accepted. `window` messages are
 * ignored by the host after the port is transferred.
 */

export const BRIDGE_INIT = "bulletin:bridge:init";
export const BRIDGE_MESSAGE = "bulletin:bridge";
export const BRIDGE_RESULT = "bulletin:bridge:result";

export interface BridgeEnvelope {
  readonly token: string;
  readonly type: string;
  readonly id?: string;
}

export interface BridgeResize extends BridgeEnvelope {
  readonly type: "resize";
  readonly height: number;
}

export interface BridgeRead extends BridgeEnvelope {
  readonly type: "read";
  readonly id: string;
}

export interface BridgeRoute extends BridgeEnvelope {
  readonly type: "route";
  readonly id: string;
  readonly path: string;
  readonly method?: string;
  readonly body?: string | null;
}

export interface BridgeOpen extends BridgeEnvelope {
  readonly type: "open";
  readonly url: string;
}

export interface BridgeToast extends BridgeEnvelope {
  readonly type: "toast";
  readonly messageKey: string;
}

export type BridgeMessage = BridgeResize | BridgeRead | BridgeRoute | BridgeOpen | BridgeToast;

export interface BridgeResult {
  readonly type: typeof BRIDGE_RESULT;
  readonly token: string;
  readonly id: string;
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates one port message against the iframe's own token and the fixed message shapes. */
export function validateBridgeMessage(value: unknown, token: string): BridgeMessage | undefined {
  if (!isRecord(value) || value.token !== token || typeof value.type !== "string") {
    return undefined;
  }

  const envelope = { token, type: value.type } as const;

  switch (value.type) {
    case "resize":
      return typeof value.height === "number" && Number.isFinite(value.height)
        ? { ...envelope, type: "resize", height: Math.max(0, Math.min(4_000, value.height)) }
        : undefined;

    case "read":
      return typeof value.id === "string" ? { ...envelope, type: "read", id: value.id } : undefined;

    case "route":
      return typeof value.id === "string" &&
        typeof value.path === "string" &&
        value.path !== "" &&
        !value.path.startsWith("/") &&
        !value.path.includes("..")
        ? {
            ...envelope,
            type: "route",
            id: value.id,
            path: value.path,
            method: typeof value.method === "string" ? value.method : "GET",
            body: typeof value.body === "string" ? value.body : null,
          }
        : undefined;

    case "open":
      return typeof value.url === "string" && /^https?:\/\//i.test(value.url)
        ? { ...envelope, type: "open", url: value.url }
        : undefined;

    case "toast":
      return typeof value.messageKey === "string" && value.messageKey !== ""
        ? { ...envelope, type: "toast", messageKey: value.messageKey }
        : undefined;

    default:
      return undefined;
  }
}

export interface HostBridgeHandlers {
  readonly read: () => Readonly<Record<string, unknown>>;
  readonly route: (
    path: string,
    method: string,
    body: string | null,
  ) => Promise<{ readonly status: number; readonly body: string }>;
  readonly open: (url: string) => void;
  readonly toast: (messageKey: string) => void;
  readonly resize: (height: number) => void;
  readonly report?: (message: string) => void;
}

/**
 * Host side of one iframe bridge. It never subscribes to `window` messages; the caller
 * transfers `port2` to the iframe. Call `handle` only from that private port.
 */
export function createHostBridge(
  token: string,
  handlers: HostBridgeHandlers,
  options: { readonly messagesPerSecond?: number } = {},
) {
  let windowStarted = performance.now();
  let messages = 0;
  const limit = options.messagesPerSecond ?? 50;

  return {
    async handle(value: unknown): Promise<BridgeResult | undefined> {
      const now = performance.now();

      if (now - windowStarted >= 1_000) {
        windowStarted = now;
        messages = 0;
      }

      messages += 1;

      if (messages > limit) {
        handlers.report?.("bridge rate limit exceeded");
        return undefined;
      }

      const message = validateBridgeMessage(value, token);

      if (message === undefined) {
        return undefined;
      }

      switch (message.type) {
        case "resize":
          handlers.resize(message.height);
          return undefined;
        case "open":
          handlers.open(message.url);
          return undefined;
        case "toast":
          handlers.toast(message.messageKey);
          return undefined;
        case "read":
          return {
            type: BRIDGE_RESULT,
            token,
            id: message.id,
            ok: true,
            data: handlers.read(),
          };
        case "route": {
          try {
            const result = await handlers.route(
              message.path,
              message.method ?? "GET",
              message.body ?? null,
            );
            return { type: BRIDGE_RESULT, token, id: message.id, ok: true, data: result };
          } catch {
            return {
              type: BRIDGE_RESULT,
              token,
              id: message.id,
              ok: false,
              error: "route_failed",
            };
          }
        }
      }
    },
  };
}

export interface PluginBridgeLink {
  readonly token: string | null;
  readonly request: (
    path: string,
    options?: { readonly method?: string; readonly body?: string | null },
  ) => Promise<{ readonly status: number; readonly body: string }>;
  readonly read: () => Promise<Readonly<Record<string, unknown>>>;
  readonly resize: (height: number) => void;
  readonly open: (url: string) => void;
  readonly toast: (messageKey: string) => void;
}

/**
 * Guest side. It accepts exactly one init message from the parent on `window`, then only
 * uses the transferred port; later `window` messages are ignored.
 */
interface BrowserWindow {
  readonly parent: unknown;
  addEventListener(type: "message", listener: (event: BridgeInitEvent) => void): void;
  removeEventListener(type: "message", listener: (event: BridgeInitEvent) => void): void;
}

interface BridgeInitEvent {
  readonly source: unknown;
  readonly data: { readonly type?: unknown; readonly token?: unknown } | null;
  readonly ports: readonly MessagePort[];
}

export function connectPluginBridge(): Promise<PluginBridgeLink> {
  const win = (globalThis as unknown as { readonly window: BrowserWindow }).window;

  return new Promise((resolve) => {
    const onInit = (event: BridgeInitEvent): void => {
      if (event.source !== win.parent || event.data?.type !== BRIDGE_INIT) {
        return;
      }

      const data = event.data;
      const port = event.ports[0];

      if (typeof data.token !== "string" || port === undefined) {
        return;
      }

      win.removeEventListener("message", onInit);
      const token = data.token;
      const pending = new Map<
        string,
        (result: { ok: boolean; data?: unknown; error?: string }) => void
      >();
      let nextId = 0;

      port.onmessage = (message): void => {
        const result = message.data as Partial<BridgeResult> | undefined;

        if (
          result?.type !== BRIDGE_RESULT ||
          result.token !== token ||
          typeof result.id !== "string"
        ) {
          return;
        }

        pending.get(result.id)?.({
          ok: result.ok === true,
          ...(result.data === undefined ? {} : { data: result.data }),
          ...(result.error === undefined ? {} : { error: result.error }),
        });
        pending.delete(result.id);
      };
      port.start();

      const call = (
        body: Record<string, unknown>,
      ): Promise<{ ok: boolean; data?: unknown; error?: string }> =>
        new Promise((done) => {
          const id = `m${String(++nextId)}`;
          pending.set(id, done);
          port.postMessage({ ...body, token, id });
        });

      resolve({
        token,
        async request(path, options = {}) {
          const result = await call({
            type: "route",
            path,
            method: options.method ?? "GET",
            body: options.body ?? null,
          });

          if (!result.ok) {
            return { status: 503, body: "" };
          }

          return result.data as { status: number; body: string };
        },
        async read() {
          const result = await call({ type: "read" });
          return (result.data ?? {}) as Readonly<Record<string, unknown>>;
        },
        resize(height) {
          port.postMessage({ type: "resize", token, height });
        },
        open(url) {
          port.postMessage({ type: "open", token, url });
        },
        toast(messageKey) {
          port.postMessage({ type: "toast", token, messageKey });
        },
      });
    };

    win.addEventListener("message", onInit);
  });
}
