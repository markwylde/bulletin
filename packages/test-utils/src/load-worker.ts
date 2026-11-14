/**
 * One load-test thread: runs its share of virtual users until `stopAt`, then posts its
 * bucketed samples back. Only requests that start after `measureFrom` are recorded.
 */

import {
  type LoadRole,
  type LoadSession,
  newSamples,
  type RouteSamples,
  recordSample,
  type WorkerInput,
  type WorkerResult,
} from "./load-test.ts";

declare const self: Worker;

function pick<T>(items: readonly T[], index: number): T | undefined {
  return items.length === 0 ? undefined : items[index % items.length];
}

async function sleep(ms: number): Promise<void> {
  if (ms > 0) {
    await Bun.sleep(ms);
  }
}

async function run(input: WorkerInput): Promise<WorkerResult> {
  const { config, users, measureFrom, stopAt } = input;
  const samples = new Map<string, RouteSamples>();
  const origin = new URL(config.baseUrl).origin;
  let sseOpened = 0;
  let sseFailed = 0;
  let sseDropped = 0;

  const record = (role: LoadRole, route: string, ms: number, ok: boolean, startedAt: number) => {
    if (startedAt < measureFrom) {
      return;
    }

    const key = `${role} ${route}`;
    let target = samples.get(key);

    if (target === undefined) {
      target = newSamples(role, route);
      samples.set(key, target);
    }

    recordSample(target, ms, ok);
  };

  const timed = async (
    role: LoadRole,
    route: string,
    url: string,
    init: RequestInit,
    accept: (response: Response) => boolean = (response) => response.ok,
  ): Promise<Response | null> => {
    const startedAt = Date.now();
    const start = performance.now();

    try {
      const response = await fetch(url, { ...init, redirect: "manual" });
      // TTFB is measured on headers; the body is drained so the connection is reused.
      const ms = performance.now() - start;
      await response.arrayBuffer();
      record(role, route, ms, accept(response), startedAt);
      return response;
    } catch {
      record(role, route, performance.now() - start, false, startedAt);
      return null;
    }
  };

  const jitter = (index: number) => (index * 7_919) % Math.max(1, config.thinkMs);

  const guest = async (index: number, base: string, role: LoadRole) => {
    await sleep(Math.max(0, input.startAt - Date.now()) + jitter(index));
    let step = index;

    while (Date.now() < stopAt) {
      const path = pick(config.guestPaths, step) ?? "/";
      await timed(role, path, `${base}${path}`, { headers: { accept: "text/html" } });
      step += 1;
      await sleep(config.thinkMs);
    }
  };

  const member = async (index: number, session: LoadSession) => {
    await sleep(Math.max(0, input.startAt - Date.now()) + jitter(index));
    let step = index;

    while (Date.now() < stopAt) {
      const path = pick(config.memberPaths, step) ?? "/";
      await timed("member", path, `${config.baseUrl}${path}`, {
        headers: { accept: "text/html", cookie: session.cookie },
      });
      await timed("member", "/api/me/overlay", `${config.baseUrl}/api/me/overlay`, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          origin,
          "content-type": "application/json",
          "x-bulletin-overlay": "1",
        },
        body: JSON.stringify({ ctx: pick(config.overlayContexts, step) ?? "board" }),
      });
      step += 1;
      await sleep(config.thinkMs);
    }
  };

  const sse = async (index: number, session: LoadSession) => {
    await sleep(Math.max(0, input.startAt - Date.now()) + (index % 1_000));
    const controller = new AbortController();
    let ended = false;
    let opened = false;
    const timer = setTimeout(
      () => {
        ended = true;
        controller.abort();
      },
      Math.max(0, stopAt - Date.now()),
    );

    try {
      const response = await fetch(`${config.baseUrl}/api/stream`, {
        headers: { accept: "text/event-stream", cookie: session.cookie },
        signal: controller.signal,
      });

      if (!response.ok || response.body === null) {
        sseFailed += 1;
        return;
      }

      opened = true;
      sseOpened += 1;
      const reader = response.body.getReader();

      while (true) {
        const { done } = await reader.read();

        if (done) {
          break;
        }
      }

      // The server ended the stream before the run did.
      if (!ended) {
        sseDropped += 1;
      }
    } catch {
      // Aborting at `stopAt` ends a healthy stream; any other error is a failure to open or a
      // stream lost mid-run.
      if (!ended) {
        if (opened) {
          sseDropped += 1;
        } else {
          sseFailed += 1;
        }
      }
    } finally {
      clearTimeout(timer);
    }
  };

  const writer = async () => {
    if (users.writesPerSecond <= 0 || config.writerSessions.length === 0) {
      return;
    }

    const tokens = new Map<string, string>();

    for (const session of config.writerSessions) {
      const response = await fetch(`${config.baseUrl}/api/auth/session`, {
        headers: { accept: "application/json", cookie: session.cookie },
      });
      const body = (await response.json().catch(() => null)) as { csrfToken?: string } | null;

      if (typeof body?.csrfToken === "string") {
        tokens.set(session.cookie, body.csrfToken);
      }
    }

    const interval = 1_000 / users.writesPerSecond;
    let next = Math.max(Date.now(), input.startAt);
    let step = 0;
    const pending: Promise<unknown>[] = [];

    while (next < stopAt) {
      await sleep(next - Date.now());
      const session = pick(config.writerSessions, step);
      const topicId = pick(config.replyTopicIds, step);

      if (session !== undefined && topicId !== undefined) {
        pending.push(
          timed(
            "writer",
            "/api/topics/[id]/replies",
            `${config.baseUrl}/api/topics/${topicId}/replies`,
            {
              method: "POST",
              headers: {
                cookie: session.cookie,
                origin,
                "content-type": "application/json",
                "x-bulletin-csrf": tokens.get(session.cookie) ?? "",
              },
              body: JSON.stringify({ bodyMd: `Load test reply ${step} at ${next}.` }),
            },
            // Flood control (429) is a failed write for the capacity target.
            (response) => response.status === 200 || response.status === 201,
          ),
        );
      }

      step += 1;
      next += interval;
    }

    await Promise.all(pending);
  };

  const tasks: Promise<unknown>[] = [];

  for (let index = 0; index < users.guests; index += 1) {
    tasks.push(guest(index, config.baseUrl, "guest"));
  }

  if (config.cdnUrl !== undefined) {
    for (let index = 0; index < users.cdnGuests; index += 1) {
      tasks.push(guest(index, config.cdnUrl, "guest-cdn"));
    }
  }

  for (let index = 0; index < users.members; index += 1) {
    const session = pick(config.sessions, index);

    if (session !== undefined) {
      tasks.push(member(index, session));
    }
  }

  for (let index = 0; index < users.sseClients; index += 1) {
    const session = pick(config.sessions, index);

    if (session !== undefined) {
      tasks.push(sse(index, session));
    }
  }

  tasks.push(writer());
  await Promise.all(tasks);

  return {
    routes: [...samples.values()].map((entry) => ({
      role: entry.role,
      route: entry.route,
      count: entry.count,
      errors: entry.errors,
      buckets: entry.buckets,
    })),
    sseOpened,
    sseFailed,
    sseDropped,
  };
}

self.onmessage = (event: MessageEvent<WorkerInput>) => {
  void run(event.data).then((result) => {
    self.postMessage(result);
  });
};
