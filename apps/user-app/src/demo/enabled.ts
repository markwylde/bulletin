/**
 * The demo route exists only outside production (task 4.2). The E2E for the production mode
 * asserts this decision, and the route returns the themed 404 when it is false.
 */
export function demoEnabled(nodeEnv: string | undefined): boolean {
  return nodeEnv !== "production";
}
