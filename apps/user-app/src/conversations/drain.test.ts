import { describe, expect, test } from "bun:test";
import { drainLiveMessages } from "./drain.ts";

function messages(from: number, count: number): Array<{ id: string }> {
  return Array.from({ length: count }, (_, index) => ({ id: String(from + index) }));
}

describe("live conversation drain", () => {
  test("follows hasMore past a full first batch and reports the last rendered id", async () => {
    const pages = [messages(1, 100), messages(101, 50)];
    const rendered: string[] = [];
    const cursors: string[] = [];

    const result = await drainLiveMessages({
      after: "0",
      async fetchPage(after) {
        cursors.push(after);
        const index = pages.length === 2 ? (after === "0" ? 0 : 1) : 0;
        const page = pages[index];

        if (page === undefined) {
          return null;
        }

        return { messages: page, hasMore: index === 0 };
      },
      accept(message) {
        rendered.push(message.id);
        return true;
      },
    });

    expect(cursors).toEqual(["0", "100"]);
    expect(rendered).toHaveLength(150);
    expect(result).toEqual({ after: "150", appended: 150 });
  });

  test("does not advance the cursor when a page fetch fails", async () => {
    const result = await drainLiveMessages({
      after: "42",
      async fetchPage() {
        return null;
      },
      accept: () => true,
    });

    expect(result).toEqual({ after: "42", appended: 0 });
  });
});
