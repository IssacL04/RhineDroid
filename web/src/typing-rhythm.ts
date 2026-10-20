import { bootMotion } from "./boot-motion";

// Use the actual 25 fps text reveal, including the first character of each field.
// Glitch restoration at frames 479/485/486 is not new typing.
export const TYPING_FRAMES: readonly number[] = [
  [170, 187],
  [282, 295],
  [320, 339],
  [367, 389],
  [423, 440],
  [449, 457],
].flatMap(([start, end]) => {
  const frames: number[] = [];
  let previous = 0;
  for (let frame = start; frame <= end; frame++) {
    const motion = bootMotion(frame / 25 - 5);
    const text = frame < 200 ? motion.access : motion.auth;
    const count = text.replace(/\s/g, "").length;
    if (count > previous) frames.push(frame);
    previous = count;
  }
  return frames;
});

export function hasTypingBetween(previousVideoTime: number, videoTime: number) {
  return TYPING_FRAMES.some(
    (frame) =>
      frame / 25 > previousVideoTime + 1e-6 && frame / 25 <= videoTime + 1e-6,
  );
}
