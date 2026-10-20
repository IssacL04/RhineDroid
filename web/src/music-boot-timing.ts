// The music prologue owns its own edit; the measured live-scene clock stays
// unchanged. Keeping these separate prevents replay from changing camera cues.
export const MUSIC_BOOT_START_TIME = 0;
// The 2D paper starts dissolving 80 ms before the live shelf starts moving.
// Prepare the renderer before boot.start(); it need not render behind opaque art.
export const MUSIC_BOOT_SCENE_REVEAL_TIME = 3.92;
export const MUSIC_BOOT_SCENE_START = 4;
export const MUSIC_BOOT_SCENE_TIME = 21.92;
export const MUSIC_BOOT_SCENE_SPEED = 1.3;
export const MUSIC_BOOT_END_TIME = MUSIC_BOOT_SCENE_START + 5.2 / MUSIC_BOOT_SCENE_SPEED;

export const musicBootSceneTime = (time: number) =>
  MUSIC_BOOT_SCENE_TIME + Math.max(0, time - MUSIC_BOOT_SCENE_START) * MUSIC_BOOT_SCENE_SPEED;

/** Advance only the portion of a frame the scene can animate. Shader compilation
 * and a suspended tab can take seconds; that wait must not consume the sweep. */
export class MusicBootFrameClock {
  private lastTime = 0;
  private appTime = MUSIC_BOOT_START_TIME;

  reset(nowSeconds: number) {
    this.lastTime = nowSeconds;
    this.appTime = MUSIC_BOOT_START_TIME;
  }

  update(nowSeconds: number) {
    if (!Number.isFinite(nowSeconds) || nowSeconds <= this.lastTime) return this.appTime;
    // ArchiveScene also caps frame delta at 50 ms. Discard the unrendered time
    // rather than retaining a backlog that would fast-forward later frames.
    const dt = Math.min(nowSeconds - this.lastTime, 0.05);
    this.lastTime = nowSeconds;
    this.appTime = Math.min(MUSIC_BOOT_END_TIME, this.appTime + dt);
    if (MUSIC_BOOT_END_TIME - this.appTime < 1e-9) this.appTime = MUSIC_BOOT_END_TIME;
    return this.appTime;
  }
}
