import { afterAll, describe, expect, test } from "bun:test";
import { SmtpError, sendSmtpMail } from "./smtp.ts";

const ADDRESS = "secret-recipient@example.com";

const server = Bun.listen({
  port: 0,
  hostname: "127.0.0.1",
  socket: {
    open(socket) {
      socket.write("220 rejection-test ESMTP\r\n");
    },
    data(socket, chunk) {
      for (const line of chunk.toString().split("\n")) {
        const verb = line.trim().split(" ")[0]?.toUpperCase() ?? "";

        if (verb === "EHLO") {
          socket.write("250 rejection-test\r\n");
        } else if (verb === "MAIL") {
          socket.write("250 2.1.0 OK\r\n");
        } else if (verb === "RCPT") {
          // The listener deliberately echoes the address in the rejection.
          socket.write(`550 <${ADDRESS}> unavailable\r\n`);
        } else if (verb === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        }
      }
    },
  },
});

afterAll(() => {
  server.stop(true);
});

describe("SMTP errors", () => {
  test("never include the recipient address from a rejection reply", async () => {
    let failure: unknown;

    try {
      await sendSmtpMail({
        url: `smtp://127.0.0.1:${server.port}`,
        message: {
          from: "Bulletin <no-reply@bulletin.test>",
          to: ADDRESS,
          subject: "Delivery",
          text: "Body",
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SmtpError);
    expect(failure).toMatchObject({ code: "550", stage: "rcpt-to" });
    expect((failure as Error).message).not.toContain(ADDRESS);
    expect(JSON.stringify(failure)).not.toContain(ADDRESS);
  });
});
