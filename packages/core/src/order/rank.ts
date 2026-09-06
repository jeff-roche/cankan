/** Fractional ordinal ranking. */
export const DEFAULT_RANK_STEP = 1000;
export function rankBetween(before?: number, after?: number): number {
  if (before !== undefined && !Number.isFinite(before)) throw new Error("before rank must be finite");
  if (after !== undefined && !Number.isFinite(after)) throw new Error("after rank must be finite");
  if (before !== undefined && after !== undefined && before >= after) throw new Error("before rank must be less than after rank");
  if (before === undefined && after === undefined) return DEFAULT_RANK_STEP;
  if (before === undefined) return (after as number) - DEFAULT_RANK_STEP;
  if (after === undefined) return before + DEFAULT_RANK_STEP;
  const midpoint = (before + after) / 2;
  if (midpoint === before || midpoint === after) throw new Error("no representable rank between values");
  return midpoint;
}
export function normalizeRanks<T extends { readonly ordinal?: number }>(items: readonly T[]): Array<T & { ordinal: number }> {
  return items.map((item, index) => ({ ...item, ordinal: (index + 1) * DEFAULT_RANK_STEP }));
}
export const rankAfter = (rank: number): number => rankBetween(rank);
export const rankBefore = (rank: number): number => rankBetween(undefined, rank);

