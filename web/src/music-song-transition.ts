export type SongTransitionMode = "fade-out" | "fade-in-out" | "gapless";

/** New choices take precedence; older fade-off preferences keep direct playback. */
export function normalizeSongTransition(value: unknown, legacyFade?: unknown): SongTransitionMode {
  if (value === "fade-out" || value === "fade-in-out" || value === "gapless") return value;
  return legacyFade === false ? "gapless" : "fade-in-out";
}
