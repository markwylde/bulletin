import { describe, expect, test } from "bun:test";
import {
  contractTags,
  defineContract,
  findContract,
  type ViewModelContract,
  type ViewModelContractRegistry,
  validateContract,
  validateContracts,
} from "./contract.ts";

const ISLANDS = ["SpikeCounter", "Editor"];

function contract(overrides: Partial<ViewModelContract> = {}): ViewModelContract {
  return defineContract({
    route: "/forum/12",
    templates: { page: "forum", regions: ["header", "footer"] },
    deps: [{ forumId: "12", bit: "read" }],
    tags: ["forum:12", "topic:345:pages"],
    cdnCacheable: true,
    requiredIslands: ["Editor"],
    ...overrides,
  });
}

describe("validateContract", () => {
  test("accepts a complete contract", () => {
    expect(validateContract(contract(), ISLANDS)).toEqual([]);
  });

  test("requires a canonical route", () => {
    expect(validateContract(contract({ route: "forum" }), ISLANDS)[0]?.message).toContain(
      "not a canonical path",
    );
    expect(validateContract(contract({ route: "/forum/" }), ISLANDS)[0]?.message).toContain(
      "not a canonical path",
    );
  });

  test("rejects unknown capability bits, empty forums and duplicates", () => {
    const problems = validateContract(
      contract({
        deps: [
          { forumId: "", bit: "read" },
          { forumId: "12", bit: "power" as never },
          { forumId: "12", bit: "read" },
          { forumId: "12", bit: "read" },
        ],
      }),
      ISLANDS,
    );

    expect(problems.map((problem) => problem.message)).toEqual([
      "a capability dep has an empty forumId",
      'capability dep uses unknown bit "power" on forum 12',
      "capability dep 12:read is declared twice",
    ]);
  });

  test("validates static cache tags but leaves function tags to the route's own test", () => {
    expect(
      validateContract(contract({ tags: ["Forum 12", "topic:"] }), ISLANDS).map(
        (problem) => problem.message,
      ),
    ).toEqual([
      'cache tag "Forum 12" is not a valid tag name',
      'cache tag "topic:" is not a valid tag name',
    ]);
    expect(validateContract(contract({ tags: () => ["forum:12"] }), ISLANDS)).toEqual([]);
    expect(validateContract(contract({ tags: [] }), ISLANDS)).toEqual([]);
  });

  test("requires a page template", () => {
    expect(
      validateContract(contract({ templates: { page: "", regions: [] } }), ISLANDS)[0]?.message,
    ).toContain("declares no page template");
    expect(
      validateContract(contract({ templates: { page: "forum", regions: [""] } }), ISLANDS)[0]
        ?.message,
    ).toContain("declares an empty region template");
  });

  test("rejects a required island that is not in the registry", () => {
    expect(
      validateContract(contract({ requiredIslands: ["Missing"] }), ISLANDS)[0]?.message,
    ).toContain('required island "Missing" is not in the island registry');
  });

  test("validates every contract in a registry", () => {
    const registry: ViewModelContractRegistry = {
      "/forum/12": contract(),
      "/broken": contract({ route: "/broken", requiredIslands: ["Missing"] }),
    };

    expect(validateContracts(registry, ISLANDS).map((problem) => problem.route)).toEqual([
      "/broken",
    ]);
  });
});

describe("contractTags", () => {
  test("returns static tags unchanged", () => {
    expect(contractTags(contract(), {})).toEqual(["forum:12", "topic:345:pages"]);
  });

  test("calls a function with the view model", () => {
    const themed = defineContract<{ readonly theme: string; readonly plugins: number }>({
      route: "/spike/rendering",
      templates: { page: "demo", regions: ["header"] },
      deps: [],
      tags: (model) => [`theme:${model.theme}`, `plugins:${model.plugins}`],
      cdnCacheable: false,
      requiredIslands: [],
    });

    expect(contractTags(themed, { theme: "alt", plugins: 2 })).toEqual(["theme:alt", "plugins:2"]);
  });
});

describe("findContract", () => {
  const registry: ViewModelContractRegistry = {
    "/": contract({ route: "/", deps: [], tags: ["board"], requiredIslands: [] }),
    "/spike/rendering": contract({
      route: "/spike/rendering",
      deps: [],
      tags: [],
      requiredIslands: [],
    }),
    "/demo/[id]": contract({
      route: "/demo/[id]",
      deps: [],
      tags: [],
      requiredIslands: [],
    }),
  };

  test("matches exact routes first", () => {
    expect(findContract(registry, "/")?.route).toBe("/");
    expect(findContract(registry, "/spike/rendering")?.route).toBe("/spike/rendering");
  });

  test("matches parameter segments", () => {
    expect(findContract(registry, "/demo/42")?.route).toBe("/demo/[id]");
    expect(findContract(registry, "/demo/42/extra")).toBeUndefined();
  });

  test("returns undefined for an undeclared route", () => {
    expect(findContract(registry, "/missing")).toBeUndefined();
  });
});
