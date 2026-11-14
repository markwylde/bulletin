/**
 * Request gates (ADR 0020, ADR 0012). After a database restore, sessions, API keys and personal
 * data that were erased after the restore point are back in the database until the workers
 * have replayed the erasure journal. Readiness keeps load balancers away, but a proxy that
 * routes regardless must not reach a handler either: every public request is refused with a
 * 503 until each gate has passed. `/health/*` stays available.
 *
 * Gates are one-way: once every gate has passed, the result is kept for the process lifetime
 * (the journal check itself is cached the same way). While closed, a result is reused for
 * `recheckMs` so a flood of requests does not turn into a flood of storage and database reads.
 */

export interface GateCheck {
  readonly name: string;
  check(): boolean | Promise<boolean>;
}

export interface RequestGate {
  /** True once every check has passed; a check that throws counts as closed. */
  open(): Promise<boolean>;
}

export const GATE_RETRY_AFTER_SECONDS = 30;
const DEFAULT_RECHECK_MS = 1_000;

export function createRequestGate(
  checks: readonly GateCheck[],
  options: { readonly recheckMs?: number; readonly now?: () => number } = {},
): RequestGate {
  const now = options.now ?? Date.now;
  const recheckMs = options.recheckMs ?? DEFAULT_RECHECK_MS;
  let passed = checks.length === 0;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<boolean> | null = null;

  const evaluate = async (): Promise<boolean> => {
    for (const gate of checks) {
      try {
        if ((await gate.check()) !== true) {
          return false;
        }
      } catch {
        return false;
      }
    }

    return true;
  };

  return {
    async open() {
      if (passed) {
        return true;
      }

      if (now() - checkedAt < recheckMs) {
        return false;
      }

      inFlight ??= evaluate().finally(() => {
        checkedAt = now();
        inFlight = null;
      });
      passed = await inFlight;
      return passed;
    },
  };
}

/** The response for a request that arrives while a gate is closed. */
export function gateClosedResponse(body: string | null = null, contentType?: string): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "retry-after": String(GATE_RETRY_AFTER_SECONDS),
  });

  if (body === null) {
    return Response.json({ code: "restoring" }, { status: 503, headers });
  }

  headers.set("content-type", contentType ?? "text/plain; charset=utf-8");
  return new Response(body, { status: 503, headers });
}
