import { describe, expect, test } from "bun:test";
import { contractTags, findContract, validateContracts } from "@bulletin/templates";
import { ISLAND_NAMES } from "@bulletin/ui/islands";
import {
  accountContract,
  attachmentsContract,
  callbackContract,
  demoContract,
  displayNameContract,
  followsContract,
  forumContract,
  homeContract,
  loginContract,
  notificationPreferencesContract,
  notificationsContract,
  ROUTE_CONTRACTS,
  topicContract,
  unsubscribeConfirmedContract,
  unsubscribeContract,
} from "./contracts.ts";

describe("route contracts", () => {
  test("every contract passes the platform checks", () => {
    expect(validateContracts(ROUTE_CONTRACTS, ISLAND_NAMES)).toEqual([]);
  });

  test("the registry is keyed by the route each contract declares", () => {
    for (const [route, contract] of Object.entries(ROUTE_CONTRACTS)) {
      expect(contract.route).toBe(route);
    }

    expect(Object.keys(ROUTE_CONTRACTS).sort()).toEqual(
      [
        homeContract.route,
        loginContract.route,
        callbackContract.route,
        demoContract.route,
        forumContract.route,
        topicContract.route,
        displayNameContract.route,
        accountContract.route,
        unsubscribeContract.route,
        unsubscribeConfirmedContract.route,
        notificationPreferencesContract.route,
        notificationsContract.route,
        followsContract.route,
        attachmentsContract.route,
      ].sort(),
    );
  });

  test("the forum route declares its own, ancestor and announcement tags", () => {
    expect(forumContract.cdnCacheable).toBe(true);
    expect(forumContract.templates.page).toBe("forum");
    expect(contractTags(forumContract, { forumId: "5", ancestorIds: ["1", "3"] })).toEqual([
      "board",
      "announcements",
      "forum:5:announcements",
      "forum:1",
      "forum:3",
      "forum:5",
    ]);
  });

  test("the topic route carries its forum chain, quote sources and quoted forums", () => {
    expect(
      contractTags(topicContract, {
        topicId: "9",
        forumIds: ["1", "3"],
        quoteTopicIds: ["7"],
        quotePostIds: ["44"],
        quotedForumIds: ["5"],
      }),
    ).toEqual([
      "topic:9",
      "topic:9:pages",
      "board",
      "forum:1",
      "forum:3",
      "topic:7",
      "post:44:snapshots",
      "forum:5",
    ]);
  });

  test("the demo route declares deps, tags, CDN eligibility and required islands", () => {
    const contract = findContract(ROUTE_CONTRACTS, "/_demo/2");

    expect(contract).toBe(demoContract);
    expect(contract?.deps).toEqual([]);
    expect(contract?.cdnCacheable).toBe(true);
    expect(contract?.requiredIslands).toEqual(["LanguageSwitcher", "SpikeCounter"]);
    // The demo header/footer carry the board name, so a board save invalidates it too.
    expect(contractTags(demoContract, { forumId: "2" })).toEqual(["forum:2", "board"]);
    // Only the editor demo embeds the emoticon picker, so only it carries the emoticon tag.
    expect(contractTags(demoContract, { forumId: "editor", embedsEditor: true })).toEqual([
      "forum:editor",
      "board",
      "emoticons",
    ]);
    expect(ISLAND_NAMES).toContain("SpikeCounter");
    expect(ISLAND_NAMES).toContain("LanguageSwitcher");
  });

  test("every page requires the language switcher (tasks 4.4, 6.1)", () => {
    for (const contract of Object.values(ROUTE_CONTRACTS)) {
      expect(contract.requiredIslands).toContain("LanguageSwitcher");
    }

    expect(contractTags(accountContract, { memberId: "7" })).toEqual(["member:7"]);
  });

  test("only the public board shell is CDN cacheable", () => {
    expect(homeContract.cdnCacheable).toBe(true);
    expect(forumContract.cdnCacheable).toBe(true);
    expect(loginContract.cdnCacheable).toBe(false);
    expect(callbackContract.cdnCacheable).toBe(false);
    expect(accountContract.cdnCacheable).toBe(false);
  });
});
