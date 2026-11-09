export interface DrainController {
  readonly draining: boolean;
  /** Starts tracking one request; returns an idempotent completion callback. */
  track(): () => void;
  /** Waits for tracked work, bounded by `timeoutMs`. */
  drain(timeoutMs?: number): Promise<void>;
}

/** Small shared drain tracker for the Astro/Vite dev servers. */
export function createDrainController(): DrainController {
  let active = 0;
  let draining = false;
  let idleResolve: (() => void) | undefined;

  const becomeIdle = (): void => {
    if (active === 0 && idleResolve !== undefined) {
      const resolve = idleResolve;
      idleResolve = undefined;
      resolve();
    }
  };

  return {
    get draining() {
      return draining;
    },
    track() {
      active += 1;
      let finished = false;

      return () => {
        if (finished) {
          return;
        }
        finished = true;
        active -= 1;
        becomeIdle();
      };
    },
    async drain(timeoutMs = 25_000) {
      draining = true;

      if (active === 0) {
        return;
      }

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        idleResolve = finish;
      });
    },
  };
}
