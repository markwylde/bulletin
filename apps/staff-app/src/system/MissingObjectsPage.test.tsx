import { describe, expect, test } from "bun:test";
import { I18nProvider } from "@bulletin/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import messages from "../../i18n/merged/en.json";
import { MissingObjectsPage, type MissingObjectsReport } from "./MissingObjectsPage.tsx";

function render(report: MissingObjectsReport): string {
  const client = new QueryClient();
  client.setQueryData(["staff", "system", "missing-objects"], {
    pages: [report],
    pageParams: [null],
  });

  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" messages={messages}>
        <MissingObjectsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("missing files listing", () => {
  test("lists a restored attachment whose object is gone, with the last restore run", () => {
    const html = render({
      total: 1,
      nextCursor: null,
      items: [
        {
          id: "1",
          kind: "attachment",
          resourceId: "42",
          storageKey: `att/${"a".repeat(64)}`,
          detectedAt: "2026-11-14T12:00:00.000Z",
          postId: "7",
        },
      ],
      lastRun: {
        id: "3",
        trigger: "detected",
        status: "completed",
        startedAt: "2026-11-14T11:59:00.000Z",
        finishedAt: "2026-11-14T12:00:00.000Z",
        replayed: 2,
        removedObjects: 5,
        missingObjects: 1,
      },
    });

    expect(html).toContain('data-missing-total="1"');
    expect(html).toContain("1 missing file");
    expect(html).toContain("Attachment 42 (post 7)");
    expect(html).toContain(`att/${"a".repeat(64)}`);
    expect(html).toContain('data-run-status="completed"');
  });

  test("says when nothing is missing and no restore was checked", () => {
    const html = render({ total: 0, items: [], nextCursor: null, lastRun: null });

    expect(html).toContain("No missing files");
    expect(html).toContain("No restore has been checked yet.");
    expect(html).toContain("Every stored file is present.");
  });

  test("offers older rows when the API has another page", () => {
    const items = Array.from({ length: 200 }, (_, index) => ({
      id: String(400 - index),
      kind: "avatar" as const,
      resourceId: String(index + 1),
      storageKey: `av/${index}`,
      detectedAt: "2026-11-14T12:00:00.000Z",
      postId: null,
    }));
    const html = render({ total: 230, items, nextCursor: "201", lastRun: null });

    expect(html).toContain("230 missing files");
    expect(html).toContain("data-missing-load-more");
    expect(html).toContain("Load older missing files (200 shown)");
    expect(render({ total: 1, items: [], nextCursor: null, lastRun: null })).not.toContain(
      "data-missing-load-more",
    );
  });
});
