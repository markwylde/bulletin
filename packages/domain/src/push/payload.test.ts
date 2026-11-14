import { describe, expect, test } from "bun:test";
import { pushPayload, pushTitleKey } from "./payload.ts";

describe("push payload", () => {
  test("contains only a notification reference and a generic title key", () => {
    const payload = pushPayload("123", "topic.reply");

    expect(Object.keys(payload).sort()).toEqual(["n", "t"]);
    expect(payload).toEqual({ n: "123", t: "push.title.topicReply" });
    expect(JSON.stringify(payload)).not.toContain("topic title");
  });

  test("maps every notification type to a generic title key", () => {
    expect(pushTitleKey("conversation.message")).toBe("push.title.conversation");
    expect(pushTitleKey("warning.issued")).toBe("push.title.warning");
    expect(pushTitleKey("webhook.disabled")).toBe("push.title.webhookDisabled");
  });
});
