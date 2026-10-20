import { getMusicMotionSpeed, onMusicMotionSpeedChange } from "./music-motion-settings";

/** Keep a base-duration WAAPI animation continuous when the speed changes. */
export function followMusicMotionSpeed(animation: Animation) {
  animation.playbackRate = getMusicMotionSpeed();
  const unsubscribe = onMusicMotionSpeedChange((speed) => {
    animation.updatePlaybackRate(speed);
  });
  void animation.finished.then(unsubscribe, unsubscribe);
  return animation;
}

/** Third-party reels own their durations and sample their own local timelines. */
export function followRollingMotionSpeed(
  hosts: readonly HTMLElement[],
  updateDuration: () => void,
) {
  let previousSpeed = getMusicMotionSpeed();
  const requestedRates = new WeakMap<Animation, number>();
  return onMusicMotionSpeedChange((speed) => {
    for (const host of hosts) {
      for (const animation of host.getAnimations({ subtree: true })) {
        // CSS timing is already scaled through --music-motion-scale.
        if (animation instanceof CSSAnimation || animation instanceof CSSTransition) continue;
        const rate = (requestedRates.get(animation) ?? animation.playbackRate) * speed / previousSpeed;
        requestedRates.set(animation, rate);
        animation.updatePlaybackRate(rate);
      }
    }
    previousSpeed = speed;
    // This changes future reels without restarting their current transition.
    updateDuration();
  });
}
