import { describe, expect, test } from "bun:test";
import { contractTags, findContract, validateContracts } from "@bulletin/templates";
import { ISLAND_NAMES } from "@bulletin/ui/islands";
import {
  callbackContract,
  homeContract,
  loginContract,
  ROUTE_CONTRACTS,
  spikeRenderingContract,
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
        spikeRenderingContract.route,
      ].sort(),
    );
  });

  test("the demo route declares deps, tags, CDN eligibility and required islands", () => {
    const contract = findContract(ROUTE_CONTRACTS, "/spike/rendering");

    expect(contract).toBe(spikeRenderingContract);
    expect(contract?.deps).toEqual([]);
    expect(contract?.cdnCacheable).toBe(false);
    expect(contract?.requiredIslands).toEqual(["SpikeCounter"]);
    expect(contractTags(spikeRenderingContract, { theme: "alt", plugins: 2 })).toEqual([
      "theme:alt",
      "plugins",
    ]);
    expect(ISLAND_NAMES).toContain("SpikeCounter");
  });

  test("only the public board shell is CDN cacheable", () => {
    expect(homeContract.cdnCacheable).toBe(true);
    expect(loginContract.cdnCacheable).toBe(false);
    expect(callbackContract.cdnCacheable).toBe(false);
  });
});
