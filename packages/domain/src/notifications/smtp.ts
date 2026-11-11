/**
 * A small SMTP client for the notification email job (ADR 0001: Bun TCP, no mail library).
 * It speaks the subset the local mock and ordinary relays need: EHLO, optional AUTH PLAIN,
 * MAIL/RCPT, DATA with dot-stuffing, QUIT. Every command has a deadline.
 */

export interface SmtpMessage {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface SmtpOptions {
  /** `smtp://host:port`, optionally with `user:pass@`. */
  readonly url: string;
  readonly message: SmtpMessage;
  readonly timeoutMs?: number;
}

function mailbox(value: string): string {
  return /<([^>]+)>/.exec(value)?.[1]?.trim() ?? value.trim();
}

function headerValue(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function bodyLines(value: string): string[] {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line));
}

/** Builds the DATA payload: headers, an alternative text/HTML body, and the final dot line. */
export function buildRawMessage(message: SmtpMessage): string {
  const boundary = `bulletin-${crypto.randomUUID()}`;
  const headers: string[] = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${headerValue(message.subject)}`,
    "MIME-Version: 1.0",
    ...Object.entries(message.headers ?? {}).map(([key, value]) => `${key}: ${value}`),
  ];

  if (message.html === undefined) {
    headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit");
    return [...headers, "", ...bodyLines(message.text), "."].join("\r\n");
  }

  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const parts = [
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    ...bodyLines(message.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    ...bodyLines(message.html),
    `--${boundary}--`,
    ".",
  ];

  return [...headers, ...parts].join("\r\n");
}

export async function sendSmtpMail(options: SmtpOptions): Promise<void> {
  const url = new URL(options.url);
  const port = url.port === "" ? 25 : Number(url.port);

  if (url.hostname === "" || !Number.isSafeInteger(port) || port < 1) {
    throw new Error(`Invalid SMTP URL: ${options.url}`);
  }

  let buffer = "";
  const lines: string[] = [];
  let waiter: (() => void) | null = null;
  let closedError: Error | null = null;

  const socket = await Bun.connect({
    hostname: url.hostname,
    port,
    socket: {
      data(_socket, chunk) {
        buffer += chunk.toString("utf8");

        for (;;) {
          const newline = buffer.indexOf("\n");

          if (newline === -1) {
            break;
          }

          lines.push(buffer.slice(0, newline).replace(/\r$/, ""));
          buffer = buffer.slice(newline + 1);
        }

        waiter?.();
      },
      error(_socket, error) {
        closedError = error;
        waiter?.();
      },
      close() {
        closedError ??= new Error("SMTP connection closed");
        waiter?.();
      },
    },
  });

  const readLine = async (): Promise<string> => {
    for (;;) {
      const line = lines.shift();

      if (line !== undefined) {
        return line;
      }

      if (closedError !== null) {
        throw closedError;
      }

      await new Promise<void>((resolve) => {
        waiter = resolve;
      });
      waiter = null;
    }
  };

  const expect = async (codes: readonly string[]): Promise<void> => {
    const line = await readLine();
    const code = line.slice(0, 3);

    if (!codes.includes(code)) {
      throw new Error(`SMTP ${code}: ${line}`);
    }

    if (line[3] === "-") {
      await expect(codes);
    }
  };

  const command = async (value: string, codes: readonly string[]): Promise<void> => {
    socket.write(`${value}\r\n`);
    await expect(codes);
  };

  const exchange = async (): Promise<void> => {
    await expect(["220"]);
    await command("EHLO bulletin.local", ["250"]);

    if (url.username !== "") {
      const credentials = Buffer.from(
        `\u0000${decodeURIComponent(url.username)}\u0000${decodeURIComponent(url.password)}`,
        "utf8",
      ).toString("base64");
      await command(`AUTH PLAIN ${credentials}`, ["235"]);
    }

    await command(`MAIL FROM:<${mailbox(options.message.from)}>`, ["250"]);
    await command(`RCPT TO:<${mailbox(options.message.to)}>`, ["250", "251"]);
    await command("DATA", ["354"]);
    socket.write(`${buildRawMessage(options.message)}\r\n`);
    await expect(["250"]);
    await command("QUIT", ["221"]);
  };

  const timeoutMs = options.timeoutMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      exchange(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("SMTP timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    socket.end();
  }
}
