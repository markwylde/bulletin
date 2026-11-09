import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { escapeHtml, htmlResponse, jsonResponse, renderPage } from "@bulletin/mock-ui";

export interface WebhookRequest {
  readonly id: string;
  readonly receivedAt: Date;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signatureValid: boolean;
  readonly signaturePresent: boolean;
}

export interface WebhookStore {
  add(request: WebhookRequest): void;
  list(): readonly WebhookRequest[];
  clear(): void;
}

export function createWebhookStore(limit = 200): WebhookStore {
  const requests: WebhookRequest[] = [];

  return {
    add(request) {
      requests.unshift(request);
      if (requests.length > limit) {
        requests.length = limit;
      }
    },
    list: () => requests,
    clear() {
      requests.length = 0;
    },
  };
}

function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function safeEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");

  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

/** Verifies `X-Bulletin-Signature` over `X-Bulletin-Timestamp.body` (ADR 0016). */
export function verifySignature(
  secret: string,
  headers: Headers,
  body: string,
): { present: boolean; valid: boolean } {
  const timestamp = headers.get("x-bulletin-timestamp");
  const signature = headers.get("x-bulletin-signature");

  if (timestamp === null || signature === null) {
    return { present: false, valid: false };
  }

  const normalized = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;

  return { present: true, valid: safeEqual(hmac(secret, `${timestamp}.${body}`), normalized) };
}

export function createWebhookHandler(
  store: WebhookStore,
  secret: string,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok", requests: store.list().length });
    }

    if (url.pathname === "/api/requests") {
      return jsonResponse(store.list());
    }

    if (request.method === "POST" && (url.pathname === "/hook" || url.pathname === "/webhooks")) {
      const body = await request.text();
      const check = verifySignature(secret, request.headers, body);

      store.add({
        id: randomUUID(),
        receivedAt: new Date(),
        headers: Object.fromEntries(request.headers.entries()),
        body,
        signatureValid: check.valid,
        signaturePresent: check.present,
      });

      return jsonResponse({ status: "captured", signatureValid: check.valid }, 202);
    }

    if (url.pathname !== "/" && url.pathname !== "") {
      return new Response("Not found", { status: 404 });
    }

    const requests = store.list();
    const body =
      requests.length === 0
        ? '<p class="empty">No webhook requests captured yet.</p>'
        : `<div class="panel"><table>
            <thead><tr><th>Received</th><th>Signature</th><th>Body</th></tr></thead>
            <tbody>${requests
              .map(
                (entry) => `<tr>
                  <td>${escapeHtml(entry.receivedAt.toISOString())}</td>
                  <td>${
                    entry.signaturePresent
                      ? entry.signatureValid
                        ? "<strong>valid</strong>"
                        : "<strong>invalid</strong>"
                      : "missing"
                  }</td>
                  <td><pre>${escapeHtml(entry.body)}</pre></td>
                </tr>`,
              )
              .join("")}</tbody>
          </table></div>`;

    return htmlResponse(
      renderPage(
        "Webhook mock",
        `<p class="lede">POST to <code>/hook</code>. Signatures are checked over <code>timestamp.body</code>.</p>${body}`,
      ),
    );
  };
}
