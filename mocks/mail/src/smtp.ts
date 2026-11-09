import { type MailStore, parseMessage } from "./message.ts";

interface SmtpState {
  buffer: string;
  from: string;
  recipients: string[];
  inData: boolean;
  dataLines: string[];
}

export interface SmtpServer {
  readonly port: number;
  stop(): void;
}

function address(value: string): string {
  return /<([^>]*)>/.exec(value)?.[1]?.trim() ?? value.replace(/^[^:]*:\s*/, "").trim();
}

function reset(state: SmtpState): void {
  state.from = "";
  state.recipients = [];
  state.inData = false;
  state.dataLines = [];
}

/** Minimal SMTP listener: enough for the application's mailer, with no delivery. */
export function startSmtpServer(options: {
  readonly port: number;
  readonly store: MailStore;
  readonly hostname?: string;
}): SmtpServer {
  const states = new WeakMap<object, SmtpState>();

  const listener = Bun.listen({
    hostname: options.hostname ?? "0.0.0.0",
    port: options.port,
    socket: {
      open(socket) {
        states.set(socket, {
          buffer: "",
          from: "",
          recipients: [],
          inData: false,
          dataLines: [],
        });
        socket.write("220 bulletin-mail ESMTP\r\n");
      },

      data(socket, chunk) {
        const state = states.get(socket);
        if (state === undefined) {
          return;
        }

        state.buffer += chunk.toString();

        for (;;) {
          const newline = state.buffer.indexOf("\n");
          if (newline === -1) {
            return;
          }

          const line = state.buffer.slice(0, newline).replace(/\r$/, "");
          state.buffer = state.buffer.slice(newline + 1);

          if (state.inData) {
            if (line === ".") {
              options.store.add(
                parseMessage(state.dataLines.join("\r\n"), {
                  from: state.from,
                  to: state.recipients,
                }),
              );
              const recipient = state.recipients[0] ?? "unknown";
              reset(state);
              socket.write(`250 2.0.0 queued as ${recipient}\r\n`);
            } else {
              state.dataLines.push(line.startsWith("..") ? line.slice(1) : line);
            }
            continue;
          }

          const [command = "", ...rest] = line.split(" ");
          const argument = rest.join(" ");
          const verb = command.toUpperCase();

          if (verb === "EHLO") {
            socket.write("250-bulletin-mail\r\n250 PIPELINING\r\n");
          } else if (verb === "HELO") {
            socket.write("250 bulletin-mail\r\n");
          } else if (verb === "MAIL") {
            state.from = address(argument);
            socket.write("250 2.1.0 OK\r\n");
          } else if (verb === "RCPT") {
            state.recipients.push(address(argument));
            socket.write("250 2.1.5 OK\r\n");
          } else if (verb === "DATA") {
            state.inData = true;
            state.dataLines = [];
            socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          } else if (verb === "RSET") {
            reset(state);
            socket.write("250 2.0.0 Reset\r\n");
          } else if (verb === "NOOP") {
            socket.write("250 2.0.0 OK\r\n");
          } else if (verb === "QUIT") {
            socket.write("221 2.0.0 Bye\r\n");
            socket.end();
          } else {
            socket.write("502 5.5.2 Command not implemented\r\n");
          }
        }
      },

      close(socket) {
        states.delete(socket);
      },

      error(_socket, error) {
        console.error("mock-mail: SMTP socket error", error.message);
      },
    },
  });

  return {
    port: listener.port,
    stop: () => listener.stop(true),
  };
}
