import { afterAll, describe, expect, test } from "bun:test";
import { SmtpError, sendSmtpMail } from "./smtp.ts";

const ADDRESS = "secret-recipient@example.com";

// Self-signed test certificate for 127.0.0.1, valid for the test lifetime.
const CERT = `-----BEGIN CERTIFICATE-----
MIICvjCCAaagAwIBAgIJANk3+JEyZCKrMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCTEyNy4wLjAuMTAeFw0yNjExMTEwOTE2MjNaFw0zNjExMDgwOTE2MjNaMBQx
EjAQBgNVBAMMCTEyNy4wLjAuMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBAJrGmhLl1kAtxBhGFjO0S3brKIGzpicm2BzFUkVjsW0Q1ertLMZoMEcizaoE
i9xo08ufcTN5kckhLHGK8UxCtpxAGDY9QxYh7Av6/Ne76a1YIJpaMlGIX4ecc8Zb
GnhTpzrgPDtxMVOo3b5fKGv4T2yKheACIL4zAaSES0Zm4dBYDj3ieseX+YH5jn/g
pc3YlQfhn1k0RVU4O4yaOl53hYiEPAh6caW1rZ59OYweB+cDqSlZ/ocbfgKWMFjG
XVtjFTAbNqLPugLH3dJRoqUYbAQR2zIZ0IUlCQ0UsrBDYl+9xswiSxiW/jenxPj/
XFf5Xo44d13SEAA58Fkce37RVz0CAwEAAaMTMBEwDwYDVR0RBAgwBocEfwAAATAN
BgkqhkiG9w0BAQsFAAOCAQEAGuuHvxQBiMGNVa3cIBL92ZXop0lf9sL+LZEoHsec
UreUPEgFiolvT5vMtJTSoC/TlDi22Rczr0tVeXQxgNzdfPLs43g9HZwebJaWSqfT
/CjJ8eWvFiAViui9KCU4JwAqIU2l6TuN0cQtE0OY0teIMTTIQU61ZeLY1ZM+0bWr
88Uw4+fhEUeT7thSNGRAF8uNpGpBEWn8gVSnMAVd69TpeDuSQ7wRN8OksxVbca+Z
79et0AFD+afx0omSu6/933vaXZbymhovZoDjEVxgBrRnTDTDDLIP3S4GzR/aGWNt
7c/9sJqP+Mn8YcjfbDBVELlm1RfvOukuvuQRdOvFf8YPLA==
-----END CERTIFICATE-----`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCaxpoS5dZALcQY
RhYztEt26yiBs6YnJtgcxVJFY7FtENXq7SzGaDBHIs2qBIvcaNPLn3EzeZHJISxx
ivFMQracQBg2PUMWIewL+vzXu+mtWCCaWjJRiF+HnHPGWxp4U6c64Dw7cTFTqN2+
Xyhr+E9sioXgAiC+MwGkhEtGZuHQWA494nrHl/mB+Y5/4KXN2JUH4Z9ZNEVVODuM
mjped4WIhDwIenGlta2efTmMHgfnA6kpWf6HG34CljBYxl1bYxUwGzaiz7oCx93S
UaKlGGwEEdsyGdCFJQkNFLKwQ2JfvcbMIksYlv43p8T4/1xX+V6OOHdd0hAAOfBZ
HHt+0Vc9AgMBAAECggEBAJq1EaT6ICKenHg29lJQUW5YuHCNBfP0m+iGRCof8GW4
glsFH9BirH8uhqz/Rl3WWn4arahqSBLnGemUnIVB2g5s8sakjb49whhnlPx/VKB0
ioI+zjU5P2PqOr92qQrFc08ifJJeHpQlIyD7NQhXd+xiulajSd9UVLwBkMyaYfVB
wUgLjfOo3zJVU2vKejSrZ4cmTmb0at1lUOpZiG7+QqReTmddzTpnfApdduyQFjZ1
P/te83R9wVRKU3aQjvydgZ6ER/9g9LioAR/qk/rKaKiSZPUAsB5FjYgYSULogAsw
X+Bn5PZ3wgpHFzU1GAlHaGVQ1cgHdkBUmmfuNY83MvECgYEAzEkzgz6CO+a20mSF
gShu7hR8HSlnUFwdKPqhwxzcFtTwXZTgo7kpz1vHnWDD3Ja+VuTVqZJh5rT/DskD
5/Fhvzd9P4+aZP56KdTANXNJQDiXS/U7hdzA387Cf9EghNQVqCVPFuRLinJQcDC5
SRMdXRAYfsDI6rCLYqapxpRMy5sCgYEAwfTiJyMTwoiYK7JxxR/Rbhqf9wdRtaxe
f6I7y9ZVAVz9czozUh7MpubODY256wKxX6Vb/be9te7lHlaELQzqqUG0Dvopo6NK
Xdg5o7Jm2O9vcH4byEMrazvkHXmZ/5+x5Kezh18HZ9H/lbMTdH0etx1EJXkT+Db0
/qpFMnLSsgcCgYEAuT/wTKXUp8lSJHwvbK5j2dYNrswq+f5uGwkcw7haBQJYbiRh
iVaSCY3q+FYVhuXT+SxObRVnXjTnzlqPBjgoMaR6Gbd5hPgXg/N/0XiYBnrLCIB7
16oV5V6zlgDogkto0C/1BodD0WpUc0hb3V5OFGRSMi9Ugy5RV8ZW0tMMyN0CgYAF
jtTkNjccvflOV0C3W2AO/ahT1dvbjuLuWWHJR40MCvQgVyydT9Chf7+r18HaICuh
CAYI0TkYe44JPoVvHQ2kaAOW4khLLiS1Z7rPHA+ia8oPuS1mobYezoqM5a0qDBN2
7+9PE8QMj5H5YjZOgj9dE/Od90hBNqHyokJ1XaD4BQKBgAcQsSSIZPLlmKe885+u
bu5paHN1yHGOI5ULmZDXJDWduGHAiZt3WuqNilYI2BCifCYy1yjVFtLXktbmqqAK
4xNx6Vku5URXrGabsu4hPTZ9hVH8ENL7FwdL6hDi2xY5jX0XLLsyuOQbGBDwdhT0
XvuX9MXFcHh/4zbD746dhnRc
-----END PRIVATE KEY-----`;

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
  test("delivers over verified TLS and refuses plaintext AUTH", async () => {
    let received = false;
    let inData = false;
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: CERT, key: KEY },
      socket: {
        open(socket) {
          socket.write("220 tls-test ESMTP\r\n");
        },
        data(socket, chunk) {
          for (const line of chunk.toString().split("\n")) {
            const value = line.replace(/\r$/, "");

            if (inData) {
              if (value === ".") {
                inData = false;
                received = true;
                socket.write("250 2.0.0 queued\r\n");
              }
              continue;
            }

            const verb = value.toUpperCase();

            if (verb.startsWith("EHLO")) {
              socket.write("250 tls-test\r\n");
            } else if (verb.startsWith("MAIL")) {
              socket.write("250 2.1.0 OK\r\n");
            } else if (verb.startsWith("RCPT")) {
              socket.write("250 2.1.5 OK\r\n");
            } else if (verb === "DATA") {
              inData = true;
              socket.write("354 End data\r\n");
            } else if (verb === "QUIT") {
              socket.write("221 bye\r\n");
              socket.end();
            }
          }
        },
      },
    });

    try {
      await sendSmtpMail({
        url: `smtps://127.0.0.1:${server.port}`,
        message: {
          from: "Bulletin <no-reply@bulletin.test>",
          to: ADDRESS,
          subject: "Encrypted delivery",
          text: "Body",
        },
        tls: { ca: CERT, rejectUnauthorized: true },
      });
    } finally {
      server.stop(true);
    }

    expect(received).toBe(true);

    await expect(
      sendSmtpMail({
        url: "smtp://user:secret@127.0.0.1:1",
        message: {
          from: "Bulletin <no-reply@bulletin.test>",
          to: ADDRESS,
          subject: "Plaintext",
          text: "Body",
        },
      }),
    ).rejects.toThrow(/requires TLS/);
  });

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
