import { createMailHandler } from "./app.ts";
import { createMailStore } from "./message.ts";
import { startSmtpServer } from "./smtp.ts";

const httpPort = Number(Bun.env.PORT ?? 4002);
const smtpPort = Number(Bun.env.SMTP_PORT ?? 1025);
const store = createMailStore();

Bun.serve({ port: httpPort, fetch: createMailHandler(store) });
startSmtpServer({ port: smtpPort, store });

console.log(`mock-mail HTTP on http://localhost:${httpPort}, SMTP on ${smtpPort}`);
