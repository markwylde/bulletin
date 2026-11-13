import { describe, expect, test } from "bun:test";
import { createRenderCache } from "@bulletin/cache";
import { contractTags, findContract, validateContracts } from "@bulletin/templates";
import { assertCacheVariants } from "@bulletin/test-utils/cache-variants";
import { ISLAND_NAMES } from "@bulletin/ui/islands";
import {
  accountContract,
  apiDocsContract,
  apiKeysContract,
  attachmentsContract,
  callbackContract,
  conversationContract,
  conversationsContract,
  demoContract,
  displayNameContract,
  followsContract,
  forumContract,
  homeContract,
  leaderboardContract,
  loginContract,
  memberListContract,
  moderationLogContract,
  moderationQueueContract,
  moderationReportContract,
  moderationReportsContract,
  moderationWarningsContract,
  notificationPreferencesContract,
  notificationsContract,
  onlineContract,
  pluginPageContract,
  profileContract,
  profileEditContract,
  ROUTE_CONTRACTS,
  searchContract,
  searchMemberContract,
  searchNewContract,
  topicContract,
  unsubscribeConfirmedContract,
  unsubscribeContract,
  warningsContract,
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
        apiDocsContract.route,
        apiKeysContract.route,
        loginContract.route,
        callbackContract.route,
        demoContract.route,
        forumContract.route,
        topicContract.route,
        displayNameContract.route,
        accountContract.route,
        profileEditContract.route,
        profileContract.route,
        memberListContract.route,
        onlineContract.route,
        leaderboardContract.route,
        pluginPageContract.route,
        unsubscribeContract.route,
        unsubscribeConfirmedContract.route,
        moderationQueueContract.route,
        moderationLogContract.route,
        warningsContract.route,
        moderationWarningsContract.route,
        moderationReportsContract.route,
        moderationReportContract.route,
        notificationPreferencesContract.route,
        notificationsContract.route,
        followsContract.route,
        attachmentsContract.route,
        conversationsContract.route,
        conversationContract.route,
        searchContract.route,
        searchMemberContract.route,
        searchNewContract.route,
      ].sort(),
    );
  });

  test("the forum route declares its own, ancestor and announcement tags", () => {
    expect(forumContract.cdnCacheable).toBe(true);
    expect(forumContract.templates.page).toBe("forum");
    expect(contractTags(forumContract, { forumId: "5", ancestorIds: ["1", "3"] })).toEqual([
      "board",
      "filters",
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
      "filters",
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

  test("the search and activity routes are registered as private, no-store pages", () => {
    const routes = [
      { path: "/search", contract: searchContract },
      { path: "/search/member/12-regular-member", contract: searchMemberContract },
      { path: "/search/new", contract: searchNewContract },
    ] as const;

    for (const { path, contract } of routes) {
      expect(findContract(ROUTE_CONTRACTS, path)).toBe(contract);
      expect(contract.cdnCacheable).toBe(false);
      expect(contract.tags).toEqual([]);
      expect(contract.templates.page).toBe("search");
      expect(contract.requiredIslands).toContain("LanguageSwitcher");
    }
  });

  test("the API pages declare a public docs contract and a private keys contract", () => {
    expect(
      validateContracts(
        {
          [apiDocsContract.route]: apiDocsContract,
          [apiKeysContract.route]: apiKeysContract,
        },
        ISLAND_NAMES,
      ),
    ).toEqual([]);
    expect(apiDocsContract.cdnCacheable).toBe(true);
    expect(apiDocsContract.tags).toEqual([]);
    expect(apiKeysContract.cdnCacheable).toBe(false);
    expect(contractTags(apiKeysContract, { memberId: "7" })).toEqual(["member:7"]);
    expect(findContract(ROUTE_CONTRACTS, "/api-docs")).toBe(apiDocsContract);
    expect(findContract(ROUTE_CONTRACTS, "/account/api-keys")).toBe(apiKeysContract);
  });

  test("registers both API pages with the cache variant harness", async () => {
    const docsCache = createRenderCache({
      tags: { version: () => "1", isTrusted: () => true },
    });
    const keysCache = createRenderCache({
      tags: { version: () => "1", isTrusted: () => true },
    });

    await assertCacheVariants({
      route: apiDocsContract.route,
      cache: docsCache,
      cases: [
        {
          name: "english guest",
          render: async () => {
            const result = await docsCache.getOrRender({
              tags: contractTags(apiDocsContract, {}),
              prepare: async () => ({ key: "api-docs:en", data: undefined }),
              render: () => "<p>API docs en</p>",
            });
            return { variant: result.key, html: result.html, cache: result.status };
          },
        },
        {
          name: "french guest",
          render: async () => {
            const result = await docsCache.getOrRender({
              tags: contractTags(apiDocsContract, {}),
              prepare: async () => ({ key: "api-docs:fr", data: undefined }),
              render: () => "<p>API docs fr</p>",
            });
            return { variant: result.key, html: result.html, cache: result.status };
          },
        },
      ],
    });

    await assertCacheVariants({
      route: apiKeysContract.route,
      cache: keysCache,
      cases: [
        {
          name: "member one",
          render: async () => {
            const result = await keysCache.getOrRender({
              tags: contractTags(apiKeysContract, { memberId: "1" }),
              prepare: async () => ({ key: "keys:1", data: undefined }),
              render: () => "<p>prefix blt_aaaaaaaa</p>",
            });
            return { variant: result.key, html: result.html, cache: result.status };
          },
        },
        {
          name: "member two",
          render: async () => {
            const result = await keysCache.getOrRender({
              tags: contractTags(apiKeysContract, { memberId: "2" }),
              prepare: async () => ({ key: "keys:2", data: undefined }),
              render: () => "<p>prefix blt_bbbbbbbb</p>",
            });
            return { variant: result.key, html: result.html, cache: result.status };
          },
        },
      ],
      leaks: [
        {
          markers: ["blt_aaaaaaaa"],
          absentFrom: ["member two"],
        },
      ],
    });
  });
});
