import { describe, expect, test } from "bun:test";
import { createLogger, type Logger, REDACTED, redact, redactText } from "./log.ts";

interface CapturedLogger {
  readonly logger: Logger;
  readonly lines: string[];
}

function captureLogger(): CapturedLogger {
  const lines: string[] = [];
  const logger = createLogger({
    service: "user-api",
    level: "debug",
    sink: (line) => lines.push(line),
    now: () => new Date("2026-11-09T12:00:00.000Z"),
  });

  return { logger, lines };
}

function parseLine(lines: readonly string[], index = 0): Record<string, unknown> {
  const line = lines[index];

  if (line === undefined) {
    throw new Error("expected a log line");
  }

  return JSON.parse(line) as Record<string, unknown>;
}

describe("createLogger", () => {
  test("writes one JSON line with a request ID", () => {
    const { logger, lines } = captureLogger();

    logger.info("request completed", { requestId: "req-1", status: 200 });

    expect(lines).toHaveLength(1);

    const line = parseLine(lines);
    expect(line.time).toBe("2026-11-09T12:00:00.000Z");
    expect(line.level).toBe("info");
    expect(line.service).toBe("user-api");
    expect(line.message).toBe("request completed");
    expect(line.requestId).toBe("req-1");
    expect(line.status).toBe(200);
  });

  test("redacts an email address in a message and a field", () => {
    const { logger, lines } = captureLogger();

    logger.info("email sent to jane@example.com", { email: "jane@example.com", memberId: 7 });

    const line = parseLine(lines);
    expect(line.message).toBe("email sent to [redacted]");
    expect(line.email).toBe(REDACTED);
    expect(line.memberId).toBe(7);
    expect(lines[0]).not.toContain("jane@example.com");
  });

  test("redacts IPv4 and IPv6 addresses", () => {
    const { logger, lines } = captureLogger();

    logger.warn("login from 203.0.113.7 and 2001:db8::1", { ipAddress: "198.51.100.4" });

    const line = parseLine(lines);
    expect(line.message).toBe("login from [redacted] and [redacted]");
    expect(line.ipAddress).toBe(REDACTED);
    expect(lines[0]).not.toContain("203.0.113.7");
    expect(lines[0]).not.toContain("2001:db8::1");
  });

  test("redacts tokens and credentials in text and fields", () => {
    const { logger, lines } = captureLogger();

    logger.error("authorization: Bearer abc.def", {
      accessToken: "secret-token",
      password: "hunter2",
      note: "token=abc123",
    });

    const line = parseLine(lines);
    expect(line.message).toBe("authorization: Bearer [redacted]");
    expect(line.accessToken).toBe(REDACTED);
    expect(line.password).toBe(REDACTED);
    expect(line.note).toBe("token=[redacted]");
    expect(lines[0]).not.toContain("secret-token");
    expect(lines[0]).not.toContain("hunter2");
  });

  test("respects the configured log level", () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: "workers",
      level: "warn",
      sink: (line) => lines.push(line),
    });

    logger.debug("ignored");
    logger.info("ignored");
    logger.warn("kept");

    expect(lines).toHaveLength(1);
    expect(parseLine(lines).message).toBe("kept");
  });

  test("merges child fields and redacts them", () => {
    const { logger, lines } = captureLogger();

    logger
      .child({ requestId: "req-2", email: "jane@example.com" })
      .info("child", { jobId: "job-9" });

    const line = parseLine(lines);
    expect(line.requestId).toBe("req-2");
    expect(line.jobId).toBe("job-9");
    expect(line.email).toBe(REDACTED);
  });

  test("serialises bigint fields and marks circular references", () => {
    const { logger, lines } = captureLogger();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    logger.info("ids", { memberId: 42n, circular });

    const line = parseLine(lines);
    expect(line.memberId).toBe("42");
    expect(line.circular).toEqual({ self: "[circular]" });
  });
});

describe("redact", () => {
  test("redacts nested values without touching harmless data", () => {
    const redacted = redact({
      memberId: 7,
      profile: { email: "jane@example.com", displayName: "Jane" },
      visits: [{ ip: "203.0.113.7" }],
    });

    expect(redacted).toEqual({
      memberId: 7,
      profile: { email: REDACTED, displayName: "Jane" },
      visits: [{ ip: REDACTED }],
    });
  });

  test("redacts a JWT in free text", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI3In0.signature";

    expect(redactText(`ticket ${token} presented`)).toBe("ticket [redacted] presented");
  });
});
