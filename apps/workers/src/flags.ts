import { createFlagDefinitionSource, loadFlagViewer } from "@bulletin/db/flags";
import { createFlagRuntime } from "@bulletin/flags";
import type { SQL } from "bun";

/** Fail-closed flag evaluation for worker jobs (ADR 0010). */
export interface WorkerFlags {
  enabled(key: string, memberId: string | null): Promise<boolean>;
}

export function createWorkerFlags(sql: SQL): WorkerFlags {
  const runtime = createFlagRuntime(createFlagDefinitionSource(sql), { backstopMs: 0 });

  return {
    async enabled(key, memberId) {
      const [viewer] = await Promise.all([loadFlagViewer(sql, memberId), runtime.ensureFresh()]);
      return runtime.isOn(viewer, key);
    },
  };
}
