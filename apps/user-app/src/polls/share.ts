/** A choice's share of its question's votes, as a whole percentage for the result bar. */
export function pollShare(votes: number, total: number): number {
  return total > 0 ? Math.round((votes / total) * 100) : 0;
}
