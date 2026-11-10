/**
 * Visits and the personal overlay (ADR 0006, task 6.3/6.4). The page renders only
 * placeholders; members load their overlay and guests beacon a view. Cached HTML never
 * contains either payload.
 */

interface OverlayPayload {
  readonly unread?: readonly string[];
}

function overlayContext(): string | null {
  return document.querySelector("[data-overlay-ctx]")?.getAttribute("data-overlay-ctx") ?? null;
}

function pageTopicIds(): string[] {
  const ids = new Set<string>();

  for (const element of document.querySelectorAll("[data-overlay-context]")) {
    const context = element.getAttribute("data-overlay-context") ?? "";
    const topic = /^topic:([1-9]\d{0,18})$/.exec(context);

    if (topic?.[1] !== undefined) {
      ids.add(topic[1]);
    }
  }

  return [...ids];
}

function applyOverlay(payload: OverlayPayload): void {
  for (const topicId of payload.unread ?? []) {
    for (const slot of document.querySelectorAll(
      `[data-overlay-unread][data-overlay-context="topic:${CSS.escape(topicId)}"]`,
    )) {
      slot.setAttribute("data-unread", "true");
      slot.textContent = "";
    }
  }
}

async function loadOverlay(ctx: string): Promise<void> {
  try {
    const response = await fetch("/api/me/overlay", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bulletin-overlay": "1" },
      body: JSON.stringify({ ctx, topics: pageTopicIds() }),
    });

    if (!response.ok) {
      return;
    }

    applyOverlay((await response.json()) as OverlayPayload);
  } catch {
    // The overlay is an enhancement; the page works without it.
  }
}

function sendBeacon(ctx: string): void {
  if (typeof navigator.sendBeacon !== "function") {
    return;
  }

  // `sendBeacon` cannot set headers; same-origin requests still carry Origin and cookies.
  navigator.sendBeacon(
    "/api/beacon",
    new Blob([JSON.stringify({ ctx })], { type: "application/json" }),
  );
}

const ctx = overlayContext();

if (ctx !== null) {
  if (document.documentElement.dataset.visitor === "member") {
    void loadOverlay(ctx);
  } else {
    sendBeacon(ctx);
  }
}
