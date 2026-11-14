import { randomUUID } from "node:crypto";
import { escapeHtml, htmlResponse, jsonResponse, renderPage } from "@bulletin/mock-ui";
import { decryptPushBody } from "./decrypt.ts";

export interface PushMessage {
  readonly id: string;
  readonly receivedAt: Date;
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface PushStore {
  add(message: PushMessage): void;
  list(): readonly PushMessage[];
  clear(): void;
}

export function createPushStore(limit = 200): PushStore {
  const messages: PushMessage[] = [];

  return {
    add(message) {
      messages.unshift(message);
      if (messages.length > limit) {
        messages.length = limit;
      }
    },
    list: () => messages,
    clear() {
      messages.length = 0;
    },
  };
}

function displayBody(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body, null, 2);
}

export function createPushHandler(store: PushStore): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok", messages: store.list().length });
    }

    if (url.pathname === "/api/messages") {
      return jsonResponse(store.list());
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/push" || url.pathname === "/send" || url.pathname.startsWith("/push/"))
    ) {
      // `/push/gone` models an expired subscription so tests can prove 410 cleanup.
      if (/(?:^|\/)gone(?:\/|$)/.test(url.pathname)) {
        return new Response("Gone", { status: 410 });
      }

      const headers = Object.fromEntries(request.headers.entries());
      let body: unknown;
      const encoding = (headers["content-encoding"] ?? "").toLowerCase();

      if (encoding === "aes128gcm") {
        try {
          const decrypted = decryptPushBody(Buffer.from(await request.arrayBuffer()));

          try {
            body = JSON.parse(decrypted.payload) as unknown;
          } catch {
            body = decrypted.payload;
          }
        } catch (error) {
          body = { error: error instanceof Error ? error.message : String(error) };
        }
      } else {
        const raw = await request.text();
        body = raw;

        try {
          body = JSON.parse(raw) as unknown;
        } catch {
          // Keep non-JSON payloads as text; push payloads are opaque to the mock.
        }
      }

      store.add({
        id: randomUUID(),
        receivedAt: new Date(),
        endpoint: url.pathname,
        headers,
        body,
      });

      return jsonResponse({ status: "captured" }, 201);
    }

    if (url.pathname !== "/" && url.pathname !== "") {
      return new Response("Not found", { status: 404 });
    }

    const messages = store.list();
    const body =
      messages.length === 0
        ? '<p class="empty">No push payloads captured yet.</p>'
        : `<div class="panel"><table>
            <thead><tr><th>Received</th><th>Content type</th><th>Payload</th></tr></thead>
            <tbody>${messages
              .map(
                (message) => `<tr>
                  <td>${escapeHtml(message.receivedAt.toISOString())}</td>
                  <td>${escapeHtml(message.headers["content-type"] ?? "")}</td>
                  <td><pre>${escapeHtml(displayBody(message.body))}</pre></td>
                </tr>`,
              )
              .join("")}</tbody>
          </table></div>`;

    return htmlResponse(
      renderPage(
        "Push mock",
        `<p class="lede">POST push payloads to <code>/push</code>.</p>${body}`,
      ),
    );
  };
}
