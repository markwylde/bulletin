import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { findContract, validateContracts } from "@bulletin/templates";
import { ISLAND_NAMES } from "@bulletin/ui/islands";
import { ROUTE_CONTRACTS } from "../../apps/user-app/src/contracts.ts";

// Task 2.4: CI fails when a user-app page has no view-model contract, or a contract has no
// page. JSON endpoints under `src/pages` do not render HTML and are not page routes.

const PAGES_DIR = fileURLToPath(new URL("../../apps/user-app/src/pages/", import.meta.url));

/**
 * Astro cannot route a file or directory whose name starts with an underscore, so the rest
 * route serves the public `/_demo/<id>` route (task 4.2) and the themed 404.
 */
const PAGE_ROUTE_ALIASES: Readonly<Record<string, string>> = {
  "/[...path]": "/_demo/[id]",
};

/** Maps an Astro page file to the route it serves. */
function routeOfPageFile(relativePath: string): string | null {
  const normalised = relativePath.replaceAll("\\", "/").replace(/\.astro$/, "");
  const segments = normalised.split("/").filter((segment) => segment !== "");

  // Astro ignores files and directories that start with an underscore.
  if (segments.some((segment) => segment.startsWith("_"))) {
    return null;
  }

  if (segments[segments.length - 1] === "index") {
    segments.pop();
  }

  const route = `/${segments.join("/")}`;

  return PAGE_ROUTE_ALIASES[route] ?? route;
}

async function pageRoutes(): Promise<readonly string[]> {
  const routes: string[] = [];

  for await (const path of new Bun.Glob("**/*.astro").scan({
    cwd: PAGES_DIR,
    onlyFiles: true,
  })) {
    const route = routeOfPageFile(path);

    if (route !== null) {
      routes.push(route);
    }
  }

  return routes.sort();
}

describe("route contract coverage", () => {
  test("every user-app page declares a view-model contract", async () => {
    const routes = await pageRoutes();

    expect(routes.length).toBeGreaterThan(0);

    const missing = routes.filter((route) => findContract(ROUTE_CONTRACTS, route) === undefined);

    expect(missing).toEqual([]);
  });

  test("every contract belongs to a page that exists", async () => {
    const routes = await pageRoutes();

    expect(routes).toEqual(
      Object.keys(ROUTE_CONTRACTS)
        .filter((route) => !route.includes("["))
        .sort()
        .concat(
          Object.keys(ROUTE_CONTRACTS)
            .filter((route) => route.includes("["))
            .sort(),
        )
        .sort(),
    );
  });

  test("every contract passes the platform checks", () => {
    expect(validateContracts(ROUTE_CONTRACTS, ISLAND_NAMES)).toEqual([]);
  });

  test("maps page files to routes, including the demo alias", () => {
    expect(routeOfPageFile("index.astro")).toBe("/");
    expect(routeOfPageFile("auth/login.astro")).toBe("/auth/login");
    expect(routeOfPageFile("forum/index.astro")).toBe("/forum");
    expect(routeOfPageFile("topic/[id]-[slug].astro")).toBe("/topic/[id]-[slug]");
    expect(routeOfPageFile("[...path].astro")).toBe("/_demo/[id]");
    expect(routeOfPageFile("_demo/rendering.astro")).toBeNull();
    expect(routeOfPageFile("auth/[step].astro")).toBe("/auth/[step]");
  });
});
