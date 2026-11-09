import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { createMailHandler } from "./app.ts";
import { createMailStore, type MailStore, parseMessage } from "./message.ts";
import { startSmtpServer } from "./smtp.ts";

const mailServers: Array<ReturnType<typeof startSmtpServer>> = [];
const httpServers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of mailServers.splice(0)) {
    server.stop();
  }
  for (const server of httpServers.splice(0)) {
    server.stop(true);
  }
});

async function sendMail(port: number, raw: string): Promise<void> {
  const socket = createConnection({ host: "127.0.0.1", port });
  await once(socket, "connect");

  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();

  const readResponse = async (): Promise<string> => {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) {
        throw new Error("SMTP server closed the connection");
      }
      if (/^\d{3} /.test(next.value)) {
        return next.value;
      }
    }
  };

  await readResponse();

  for (const command of [
    "EHLO test",
    "MAIL FROM:<sender@example.test>",
    "RCPT TO:<inbox@example.test>",
    "DATA",
  ]) {
    socket.write(`${command}\r\n`);
    await readResponse();
  }

  socket.write(`${raw.replace(/\r?\n/g, "\r\n")}\r\n.\r\n`);
  await readResponse();
  socket.write("QUIT\r\n");

  lines.close();
  socket.end();
}

function startMail(store: MailStore) {
  const smtp = startSmtpServer({ port: 0, store, hostname: "127.0.0.1" });
  const http = Bun.serve({ port: 0, fetch: createMailHandler(store) });
  mailServers.push(smtp);
  httpServers.push(http);

  return { smtp, http };
}

describe("mail mock", () => {
  test("parses headers and plain text", () => {
    const message = parseMessage(
      [
        "From: Sender <sender@example.test>",
        "To: Inbox <inbox@example.test>",
        "Subject: Hello there",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "The body.",
      ].join("\r\n"),
      { from: "sender@example.test", to: ["inbox@example.test"] },
    );

    expect(message.subject).toBe("Hello there");
    expect(message.text).toBe("The body.");
    expect(message.to).toEqual(["inbox@example.test"]);
  });

  test("parses multipart alternative mail", () => {
    const raw = [
      "Subject: Multipart",
      'Content-Type: multipart/alternative; boundary="boundary-1"',
      "",
      "--boundary-1",
      "Content-Type: text/plain",
      "",
      "Plain part",
      "--boundary-1",
      "Content-Type: text/html",
      "",
      "<p>HTML part</p>",
      "--boundary-1--",
    ].join("\r\n");

    const message = parseMessage(raw, { from: "sender@example.test", to: ["inbox@example.test"] });

    expect(message.text).toBe("Plain part");
    expect(message.html).toBe("<p>HTML part</p>");
  });

  test("captures a sent message and shows it in the inbox", async () => {
    const store = createMailStore();
    const { smtp, http } = startMail(store);

    await sendMail(
      smtp.port,
      [
        "From: Sender <sender@example.test>",
        "To: Inbox <inbox@example.test>",
        "Subject: Captured",
        "",
        "Hello from the SMTP test.",
      ].join("\r\n"),
    );

    expect(store.list()).toHaveLength(1);

    const response = await fetch(`http://127.0.0.1:${http.port}/api/messages`);
    const messages = (await response.json()) as Array<{ subject: string; text: string }>;

    expect(messages).toHaveLength(1);
    expect(messages[0]?.subject).toBe("Captured");
    expect(messages[0]?.text).toBe("Hello from the SMTP test.");

    const ui = await fetch(`http://127.0.0.1:${http.port}/`);
    expect(await ui.text()).toContain("Captured");
  });
});
