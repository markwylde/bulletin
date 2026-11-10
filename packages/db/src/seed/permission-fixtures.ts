import { forumSeedModule } from "./forums.ts";

/**
 * Kept as the historic export name used by permission and demo tests. The module now seeds the
 * real board structure (`forums.ts`), not a tiny set of fixtures.
 */
export const permissionFixtureSeedModule = forumSeedModule;
