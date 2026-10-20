const smoother = (value: number) => {
  const t = Math.min(1, Math.max(0, value));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/**
 * The nine-column pool recycles at ±4.5 lanes. In overview, tuck each outer
 * column into the shelf before that boundary and unfold it from the opposite
 * edge. Only vertical extent changes; cover width and depth stay constant.
 * Complete the blend before the camera reaches the wide overview framing.
 */
export function musicOverviewColumnExtent(lane: number, centerLane: number, overview: number) {
  const edge = smoother(4.5 - Math.abs(lane - centerLane));
  return 1 - smoother(overview / 0.65) * (1 - edge);
}

export const MUSIC_OVERVIEW_PICK_EXTENT = 0.12;
