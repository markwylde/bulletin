import { describe, expect, test } from "bun:test";
import { contractTags, findContract, validateContracts } from "@bulletin/templates";
import { ISLAND_NAMES } from "@bulletin/ui/islands";
import {
  accountContract,
  callbackContract,
  demoContract,
  displayNameContract,
  homeContract,
  loginContract,
  ROUTE_CONTRACTS,
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
        displayNameContract.route,
        accountContract.route,
      ].sort(),
    );
  });

  test("the demo route declares deps, tags, CDN eligibility and required islands", () => {
    const contract = findContract(ROUTE_CONTRACTS, "/_demo/2");

    expect(contract).toBe(demoContract);
    expect(contract?.deps).toEqual([]);
    expect(contract?.cdnCacheable).toBe(true);
    expect(contract?.requiredIslands).toEqual(["LanguageSwitcher", "SpikeCounter"]);
    expect(contractTags(demoContract, { forumId: "2" })).toEqual(["forum:2"]);
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
    expect(loginContract.cdnCacheable).toBe(false);
    expect(callbackContract.cdnCacheable).toBe(false);
    expect(accountContract.cdnCacheable).toBe(false);
  });
});
