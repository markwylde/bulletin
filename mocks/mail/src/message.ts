import { randomUUID } from "node:crypto";

export interface MailMessage {
  readonly id: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  readonly html: string;
  readonly raw: string;
  readonly receivedAt: Date;
}

export interface Envelope {
  readonly from: string;
  readonly to: readonly string[];
}

function decodeQuotedPrintable(value: string): string {
  return value
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
}

function decodeBody(body: string, encoding: string | undefined): string {
  const normalized = encoding?.toLowerCase().trim();

  if (normalized === "base64") {
    return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  }

  if (normalized === "quoted-printable") {
    return decodeQuotedPrintable(body);
  }

  return body;
}

function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let last = "";

  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last !== "") {
      headers[last] = `${headers[last] ?? ""} ${line.trim()}`.trim();
      continue;
    }

    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }

    last = line.slice(0, separator).toLowerCase().trim();
    headers[last] = line.slice(separator + 1).trim();
  }

  return headers;
}

function splitMessage(raw: string): { headerBlock: string; body: string } {
  const separator = raw.indexOf("\r\n\r\n");
  const alternate = raw.indexOf("\n\n");
  const index = separator === -1 ? alternate : separator;

  if (index === -1) {
    return { headerBlock: raw, body: "" };
  }

  const delimiterLength = separator === -1 ? 2 : 4;
  return {
    headerBlock: raw.slice(0, index),
    body: raw.slice(index + delimiterLength),
  };
}

function parseMultipart(
  body: string,
  boundary: string,
): Array<{ headers: Record<string, string>; body: string }> {
  const parts: Array<{ headers: Record<string, string>; body: string }> = [];

  for (const section of body.split(`--${boundary}`)) {
    const trimmed = section.replace(/^\r?\n/, "");
    if (trimmed === "" || trimmed.startsWith("--")) {
      continue;
    }

    const split = splitMessage(trimmed);
    parts.push({ headers: parseHeaders(split.headerBlock), body: split.body });
  }

  return parts;
}

function contentParts(
  headers: Record<string, string>,
  body: string,
): { text: string; html: string } {
  const contentType = headers["content-type"] ?? "text/plain";
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];

  if (contentType.toLowerCase().startsWith("multipart/") && boundary !== undefined) {
    let text = "";
    let html = "";

    for (const part of parseMultipart(body, boundary)) {
      const decoded = contentParts(part.headers, part.body);
      text ||= decoded.text;
      html ||= decoded.html;
    }

    return { text, html };
  }

  const decoded = decodeBody(body, headers["content-transfer-encoding"]);

  if (contentType.toLowerCase().includes("text/html")) {
    return { text: "", html: decoded };
  }

  return { text: decoded, html: "" };
}

export function parseMessage(raw: string, envelope: Envelope): MailMessage {
  const { headerBlock, body } = splitMessage(raw.replace(/\r\n/g, "\n"));
  const headers = parseHeaders(headerBlock);
  const decoded = contentParts(headers, body);

  return {
    id: randomUUID(),
    from: envelope.from,
    to: envelope.to,
    subject: headers.subject ?? "(no subject)",
    headers,
    text: decoded.text.trimEnd(),
    html: decoded.html.trimEnd(),
    raw,
    receivedAt: new Date(),
  };
}

export interface MailStore {
  add(message: MailMessage): void;
  list(): readonly MailMessage[];
  get(id: string): MailMessage | undefined;
  clear(): void;
}

export function createMailStore(limit = 200): MailStore {
  const messages: MailMessage[] = [];

  return {
    add(message) {
      messages.unshift(message);
      if (messages.length > limit) {
        messages.length = limit;
      }
    },
    list: () => messages,
    get: (id) => messages.find((message) => message.id === id),
    clear() {
      messages.length = 0;
    },
  };
}
