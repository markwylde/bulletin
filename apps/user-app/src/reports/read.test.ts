import { describe, expect, test } from "bun:test";
import { readReportDetailFromApi } from "./read.ts";

function payload(): unknown {
  return {
    report: {
      id: "42",
      targetType: "pm",
      targetId: "7",
      status: "open",
      assigneeId: null,
      assigneeName: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      subject: { label: "Private message", href: null },
      reporters: [],
      comments: [],
      pmMessages: [
        {
          messageId: "7",
          authorName: "Ada",
          bodyHtml: "<p>Reported message</p>",
          createdAt: "2026-01-01T00:00:00.000Z",
          reported: true,
        },
      ],
    },
  };
}

describe("report detail read", () => {
  test("forwards the session cookie to the audited user-api read", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return Response.json(payload());
    };

    const result = await readReportDetailFromApi({
      reportId: "42",
      cookie: "bl_session=token",
      fetchImpl,
      baseUrl: "http://user-api.internal:3001",
    });

    expect(result.status).toBe(200);
    expect(result.detail?.pmMessages?.[0]).toMatchObject({
      messageId: "7",
      reported: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://user-api.internal:3001/api/reports/42");
    expect(new Headers(calls[0]?.init?.headers).get("cookie")).toBe("bl_session=token");
    expect(calls[0]?.init?.cache).toBe("no-store");
  });

  test("passes a denial through without parsing a body", async () => {
    const fetchImpl = async (): Promise<Response> => new Response("{}", { status: 403 });

    expect(
      await readReportDetailFromApi({
        reportId: "42",
        cookie: null,
        fetchImpl,
        baseUrl: "http://user-api.internal:3001",
      }),
    ).toEqual({ status: 403, detail: null });
  });

  test("reports an unavailable user-api as 503", async () => {
    const thrown = async (): Promise<Response> => {
      throw new Error("connection refused");
    };
    const invalid = async (): Promise<Response> => Response.json({ nope: true });

    for (const fetchImpl of [thrown, invalid]) {
      expect(
        await readReportDetailFromApi({
          reportId: "42",
          cookie: "bl_session=token",
          fetchImpl,
          baseUrl: "http://user-api.internal:3001",
        }),
      ).toEqual({ status: 503, detail: null });
    }
  });
});
