export type MusicArrayMode = "filled" | "realistic";

/** A real shelf contains precisely one cell for each actual album. */
export function isRealAlbumCell(lane: number, row: number, counts: readonly number[]) {
  return Number.isInteger(lane) && Number.isInteger(row) && lane >= 0 && lane < counts.length &&
    row >= 12 && row < 12 + counts[lane];
}

export function normalizeMusicArrayMode(value: unknown): MusicArrayMode {
  return value === "realistic" ? "realistic" : "filled";
}

/** Center real columns in overview without changing their integer album IDs.
 * Odd counts align on the middle album; even counts straddle the same center. */
export function realAlbumOverviewOffset(count: number, browsingRow: number, progress: number) {
  if (count <= 0) return 0;
  return (browsingRow - (12 + (count - 1) / 2)) * progress;
}
