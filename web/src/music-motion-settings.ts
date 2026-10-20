export const DEFAULT_MUSIC_MOTION_SPEED = 1;
export const MIN_MUSIC_MOTION_SPEED = 0.25;
export const MAX_MUSIC_MOTION_SPEED = 3;

let speed = DEFAULT_MUSIC_MOTION_SPEED;
const listeners = new Set<(speed: number) => void>();

export function normalizeMusicMotionSpeed(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_MUSIC_MOTION_SPEED, Math.max(MIN_MUSIC_MOTION_SPEED, value))
    : DEFAULT_MUSIC_MOTION_SPEED;
}

export const getMusicMotionSpeed = () => speed;
export const musicMotionDuration = (milliseconds: number) => milliseconds / speed;

export function setMusicMotionSpeed(value: unknown) {
  const next = normalizeMusicMotionSpeed(value);
  if (next === speed) return;
  speed = next;
  for (const listener of listeners) listener(speed);
}

export function onMusicMotionSpeedChange(listener: (speed: number) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
