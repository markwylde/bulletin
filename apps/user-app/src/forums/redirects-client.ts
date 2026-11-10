interface RedirectCounts {
  readonly counts: Readonly<Record<string, number>>;
}

function apply(counts: Readonly<Record<string, number>>): void {
  for (const element of document.querySelectorAll<HTMLElement>("[data-redirect-clicks]")) {
    const id = element.getAttribute("data-redirect-clicks") ?? "";
    const count = counts[id];

    if (!Number.isFinite(count)) {
      continue;
    }

    const suffix =
      count === 1
        ? (element.getAttribute("data-click-suffix-one") ?? "")
        : (element.getAttribute("data-click-suffix-other") ?? "");

    element.textContent = `${count} ${suffix}`.trim();
  }
}

fetch("/api/forums/redirect-counts", {
  credentials: "include",
  headers: { accept: "application/json" },
})
  .then((response) => (response.ok ? response.json() : null))
  .then((payload: RedirectCounts | null) => {
    if (payload !== null && typeof payload.counts === "object") {
      apply(payload.counts);
    }
  })
  .catch(() => {
    // The server-rendered counter remains as a fallback.
  });
