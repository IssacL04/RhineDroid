import { followMusicMotionSpeed } from "./music-motion-ui";

const enterEase = "cubic-bezier(0.22, 1, 0.36, 1)";
const exitEase = "cubic-bezier(0.4, 0, 1, 1)";

/** Owns the visible lifetime, including a close that interrupts an opening. */
export class SurfaceTransition {
  private animations: Animation[] = [];
  private revision = 0;

  constructor(
    private root: HTMLElement,
    private panel?: HTMLElement,
    private enterDuration = 300,
    private exitDuration = 200,
    private direction: "up" | "right" = "up",
    private enterEasing = enterEase,
    // Separate overlays can fade together without changing their common
    // ancestor's stacking context or flattening them into a full-screen layer.
    private fadeTargets: readonly HTMLElement[] = [root],
    private collapsedScale = 1,
  ) {}

  show(reduced: boolean) {
    this.run(true, reduced);
  }

  hide(reduced: boolean, finished: () => void = () => {}) {
    this.run(false, reduced, finished);
  }

  finish() {
    this.animations.forEach((animation) => animation.finish());
  }

  dispose() {
    this.revision++;
    this.animations.forEach((animation) => animation.cancel());
    this.animations = [];
  }

  private run(show: boolean, reduced: boolean, finished?: () => void) {
    const revision = ++this.revision;
    const hidden = this.root.hidden;
    const interrupted = this.animations.length > 0;
    const opacities = this.fadeTargets.map((target) =>
      hidden ? "0" : getComputedStyle(target).opacity,
    );
    const scale = this.collapsedScale === 1 ? "" : ` scale(${this.collapsedScale})`;
    const transform = this.panel
      ? hidden
        ? (this.direction === "right" ? "translateX(24px)" : "translateY(10px)") + scale
        : getComputedStyle(this.panel).transform
      : undefined;
    this.animations.forEach((animation) => animation.cancel());
    this.animations = [];
    this.root.hidden = false;
    this.root.dataset.transition = show ? "opening" : "closing";
    const complete = () => {
      if (revision !== this.revision) return;
      this.root.hidden = !show;
      this.root.dataset.transition = show ? "open" : "closed";
      this.animations.forEach((animation) => animation.cancel());
      this.animations = [];
      finished?.();
    };
    if (reduced || (!show && hidden)) {
      complete();
      return;
    }
    // A late reversal travels a short distance. Replaying a full entrance here
    // makes rapid open/back input feel sticky even when its first pixel matches.
    const distance = Math.max(...opacities.map((opacity) =>
      Math.abs((show ? 1 : 0) - Number(opacity))), 0);
    const baseDuration = show ? this.enterDuration : this.exitDuration;
    const options: KeyframeAnimationOptions = {
      duration: interrupted ? Math.max(72, baseDuration * Math.sqrt(distance)) : baseDuration,
      easing: show ? this.enterEasing : exitEase,
      fill: "both",
    };
    const fades = this.fadeTargets.map((target, index) => followMusicMotionSpeed(target.animate(
      [{ opacity: opacities[index] }, { opacity: show ? 1 : 0 }],
      options,
    )));
    this.animations.push(...fades);
    if (this.panel) {
      this.animations.push(
        followMusicMotionSpeed(this.panel.animate(
          [
            { transform },
            { transform: this.direction === "right"
              ? show ? "translateX(0)" : "translateX(32px)" + scale
              : show ? "translateY(0)" : "translateY(6px)" + scale },
          ],
          options,
        )),
      );
    }
    void Promise.all(fades.map((fade) => fade.finished)).then(complete).catch(() => {});
  }
}

export class ContentTransition {
  private animation?: Animation;

  reveal(element: HTMLElement, reduced: boolean) {
    const opacity =
      this.animation?.playState === "running"
        ? getComputedStyle(element).opacity
        : "0.35";
    this.cancel();
    if (!reduced)
      this.animation = followMusicMotionSpeed(element.animate([{ opacity }, { opacity: 1 }], {
        duration: 150,
        easing: enterEase,
      }));
  }

  cancel() {
    this.animation?.cancel();
    this.animation = undefined;
  }
}
