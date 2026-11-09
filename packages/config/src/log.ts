import { isIP } from "node:net";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const REDACTED = "[redacted]";

const MAX_DEPTH = 8;

/** Keys whose values are personal data or credentials and are always replaced. */
const SENSITIVE_KEYS = new Set([
  "ip",
  "ipaddress",
  "remoteip",
  "clientip",
  "remoteaddress",
  "clientaddress",
]);

const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passwd|apikey|authorization|cookie|credential|email)/i;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER_PATTERN = /\bBearer\s+[^\s,;]+/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|passwd|api[-_]?key)\s*[=:]\s*[^\s,;&]+/gi;
const IPV4_PATTERN = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const IPV6_CANDIDATE_PATTERN = /(?<![0-9a-z:.])[0-9a-f:]*:[0-9a-f:]*(?![0-9a-z:.])/gi;

export interface LogFields {
  readonly [key: string]: unknown;
}

export type LogSink = (line: string) => void;

export interface LoggerOptions {
  readonly service: string;
  readonly level?: LogLevel;
  readonly sink?: LogSink;
  readonly now?: () => Date;
  /** Context repeated on every line, e.g. a request or job ID. */
  readonly fields?: LogFields;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SENSITIVE_KEYS.has(normalized) || SENSITIVE_KEY_PATTERN.test(normalized);
}

function redactIpAddresses(value: string): string {
  const withoutIpv4 = value.replace(IPV4_PATTERN, (candidate) =>
    isIP(candidate) === 4 ? REDACTED : candidate,
  );

  return withoutIpv4.replace(IPV6_CANDIDATE_PATTERN, (candidate) =>
    isIP(candidate) === 6 ? REDACTED : candidate,
  );
}

/** Redacts email addresses, IP addresses and token-like values from free text. */
export function redactText(text: string): string {
  const withoutCredentials = text
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(JWT_PATTERN, REDACTED)
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(EMAIL_PATTERN, REDACTED);

  return redactIpAddresses(withoutCredentials);
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }

  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? value.toString() : value;
  }

  if (depth >= MAX_DEPTH) {
    return "[truncated]";
  }

  if (seen.has(value)) {
    return "[circular]";
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: value.stack === undefined ? undefined : redactText(value.stack),
    };
  }

  seen.add(value);

  const redacted = Array.isArray(value)
    ? value.map((item) => redactValue(item, seen, depth + 1))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          isSensitiveKey(key) ? REDACTED : redactValue(item, seen, depth + 1),
        ]),
      );

  seen.delete(value);
  return redacted;
}

/** Recursively redacts an arbitrary value; safe to use on log fields and error metadata. */
export function redact(value: unknown): unknown {
  return redactValue(value, new WeakSet(), 0);
}

/** Structured JSON logger with request/job IDs and mandatory redaction (ADR 0020). */
export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? "info";
  const sink: LogSink = options.sink ?? ((line) => console.log(line));
  const now = options.now ?? (() => new Date());
  const fields = options.fields ?? {};
  const threshold = LEVEL_WEIGHT[level];

  const write = (lineLevel: LogLevel, message: string, eventFields?: LogFields): void => {
    if (LEVEL_WEIGHT[lineLevel] < threshold) {
      return;
    }

    const redactedFields = redact({ ...fields, ...eventFields }) as LogFields;
    const record = {
      ...redactedFields,
      time: now().toISOString(),
      level: lineLevel,
      service: options.service,
      message: redactText(message),
    };

    sink(JSON.stringify(record));
  };

  return {
    debug: (message, eventFields) => write("debug", message, eventFields),
    info: (message, eventFields) => write("info", message, eventFields),
    warn: (message, eventFields) => write("warn", message, eventFields),
    error: (message, eventFields) => write("error", message, eventFields),
    child: (childFields) =>
      createLogger({
        service: options.service,
        level,
        sink,
        now,
        fields: { ...fields, ...childFields },
      }),
  };
}
