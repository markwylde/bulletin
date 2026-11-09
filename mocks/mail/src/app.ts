import { escapeHtml, htmlResponse, jsonResponse, renderPage } from "@bulletin/mock-ui";
import type { MailMessage, MailStore } from "./message.ts";

function messageRow(message: MailMessage): string {
  return `<tr>
    <td><a href="./?id=${encodeURIComponent(message.id)}">${escapeHtml(message.subject)}</a></td>
    <td>${escapeHtml(message.from)}</td>
    <td>${escapeHtml(message.to.join(", "))}</td>
    <td>${escapeHtml(message.receivedAt.toISOString())}</td>
  </tr>`;
}

function messageDetail(message: MailMessage): string {
  const headers = Object.entries(message.headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  return `<p><a href="./">Back to inbox</a></p>
    <div class="panel">
      <h2>${escapeHtml(message.subject)}</h2>
      <p><strong>From:</strong> ${escapeHtml(message.from)}<br />
      <strong>To:</strong> ${escapeHtml(message.to.join(", "))}</p>
      <h3>Headers</h3>
      <pre>${escapeHtml(headers)}</pre>
      <h3>Text</h3>
      <pre>${escapeHtml(message.text)}</pre>
      ${message.html === "" ? "" : `<h3>HTML</h3><pre>${escapeHtml(message.html)}</pre>`}
    </div>`;
}

/** HTTP inbox UI and JSON capture API. */
export function createMailHandler(store: MailStore): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok", messages: store.list().length });
    }

    if (url.pathname === "/api/messages") {
      return jsonResponse(store.list());
    }

    if (url.pathname !== "/" && url.pathname !== "") {
      return new Response("Not found", { status: 404 });
    }

    const id = url.searchParams.get("id");
    const message = id === null ? undefined : store.get(id);

    if (id !== null && message === undefined) {
      return htmlResponse(renderPage("Mail mock", "<p>Message not found.</p>"), 404);
    }

    if (message !== undefined) {
      return htmlResponse(renderPage("Mail mock", messageDetail(message)));
    }

    const messages = store.list();
    const body =
      messages.length === 0
        ? '<p class="empty">No messages captured yet.</p>'
        : `<div class="panel"><table>
            <thead><tr><th>Subject</th><th>From</th><th>To</th><th>Received</th></tr></thead>
            <tbody>${messages.map(messageRow).join("")}</tbody>
          </table></div>`;

    return htmlResponse(
      renderPage(
        "Mail mock",
        `<p class="lede">SMTP listens on port 1025 inside the compose network.</p>${body}`,
      ),
    );
  };
}
