import { useState } from "react";

export interface SpikeCounterProps {
  readonly label: string;
  readonly start?: number;
}

/** Validates untrusted template props for the spike island; returns null when invalid. */
export function parseSpikeCounterProps(input: unknown): SpikeCounterProps | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const label = record.label;

  if (typeof label !== "string" || label.trim() === "") {
    return null;
  }

  const start = record.start;

  if (start === undefined) {
    return { label };
  }

  if (typeof start !== "number" || !Number.isSafeInteger(start)) {
    return null;
  }

  return { label, start };
}

/**
 * Spike S1 island: a counter that proves server HTML is visible first and becomes
 * interactive after hydration (ADR 0008). Every label comes from the view model.
 */
export function SpikeCounter({ label, start = 0 }: SpikeCounterProps) {
  const [count, setCount] = useState(start);

  return (
    <div className="spike-counter" data-spike-counter>
      <button type="button" data-spike-increment onClick={() => setCount((value) => value + 1)}>
        {label} <span data-spike-count={count}>{count}</span>
      </button>
    </div>
  );
}
