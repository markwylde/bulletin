import { describe, expect, test } from "bun:test";
import { type ConversationErrorLabels, conversationErrorPresentation } from "./errors.ts";

const LABELS: ConversationErrorLabels = {
  recipientLimit: "Too many recipients. At most __limit__.",
  dailyLimit: "Daily limit reached.",
  quota: "Conversation quota reached.",
  manage: "Manage your conversations",
  pmDisabled: "Private messages are disabled.",
  recipientUnavailable: "A recipient is unavailable.",
  inviteBlocked: "Re-invites are blocked.",
  alreadyParticipant: "Already a participant.",
  notFound: "Conversation not found.",
};

describe("conversation error presentation", () => {
  test("uses the numeric recipient limit returned by the API", () => {
    expect(conversationErrorPresentation({ code: "recipient_limit", limit: 5 }, LABELS)).toEqual({
      text: "Too many recipients. At most 5.",
      manageUrl: null,
    });
  });

  test("points quota failures at the conversation management page", () => {
    expect(conversationErrorPresentation({ code: "quota_reached", quota: 3 }, LABELS)).toEqual({
      text: "Conversation quota reached.",
      manageUrl: "/conversations",
    });
  });

  test("returns null for an unknown code so the generic form message remains", () => {
    expect(conversationErrorPresentation({ code: "something_else" }, LABELS)).toBeNull();
  });
});
