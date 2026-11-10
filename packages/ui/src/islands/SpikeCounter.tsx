import { useState } from "react";

export interface SpikeCounterProps {
  readonly label: string;
  readonly start: number;
}

/**
 * Spike S1 island: a counter that proves server HTML is visible first and becomes
 * interactive after hydration (ADR 0008). Every label comes from the view model; the schema
 * in `schemas.ts` supplies the default start.
 */
export function SpikeCounter({ label, start }: SpikeCounterProps) {
  const [count, setCount] = useState(start);

  return (
    <div className="spike-counter" data-spike-counter>
      <button type="button" data-spike-increment onClick={() => setCount((value) => value + 1)}>
        {label} <span data-spike-count={count}>{count}</span>
      </button>
    </div>
  );
}
