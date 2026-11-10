import { createFlagDefinitionSource, loadFlagViewer } from "@bulletin/db/flags";
import { createFlagRuntime, type FlagRoute, requireFlag } from "@bulletin/flags";
import type { SQL } from "bun";

/** A fail-closed flag runtime for user-api JSON routes (ADR 0010). */
export function createUserApiFlags(sql: SQL) {
  const runtime = createFlagRuntime(createFlagDefinitionSource(sql), { backstopMs: 0 });

  return {
    guard(key: string, memberId: string | null): FlagRoute {
      return requireFlag(key, {
        runtime,
        viewer: () => loadFlagViewer(sql, memberId),
      });
    },
  };
}
