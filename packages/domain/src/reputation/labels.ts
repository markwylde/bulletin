/**
 * The reputation label scale (reputation spec): the highest threshold at or below the total
 * wins. Labels are shipped keys so every board language has a translation (ADR 0013); staff
 * configure the thresholds, not the set of labels.
 */
export const REPUTATION_LABEL_KEYS = [
  "reputation.label.notorious",
  "reputation.label.disliked",
  "reputation.label.neutral",
  "reputation.label.respected",
  "reputation.label.revered",
] as const;

export type ReputationLabelKey = (typeof REPUTATION_LABEL_KEYS)[number];

export interface ReputationLabel {
  readonly min: number;
  readonly labelKey: ReputationLabelKey;
}

export const DEFAULT_REPUTATION_LABEL_SCALE: readonly ReputationLabel[] = [
  { min: -1_000_000, labelKey: "reputation.label.notorious" },
  { min: -100, labelKey: "reputation.label.disliked" },
  { min: 0, labelKey: "reputation.label.neutral" },
  { min: 100, labelKey: "reputation.label.respected" },
  { min: 500, labelKey: "reputation.label.revered" },
];

export function isReputationLabelKey(value: string): value is ReputationLabelKey {
  return (REPUTATION_LABEL_KEYS as readonly string[]).includes(value);
}

/** The label for a total; a scale without a matching entry falls back to neutral. */
export function reputationLabelFor(
  scale: readonly ReputationLabel[],
  total: number,
): ReputationLabelKey {
  let chosen: ReputationLabelKey = "reputation.label.neutral";

  for (const entry of [...scale].sort((left, right) => left.min - right.min)) {
    if (total >= entry.min) {
      chosen = entry.labelKey;
    }
  }

  return chosen;
}
