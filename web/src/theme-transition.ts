import * as THREE from "three";

type ColorTrack = { from: THREE.Color; to: THREE.Color };
type NumberTrack = { from: number; to: number; write: (value: number) => void };

/** One clock for the scene, lighting and material palette's theme change. */
export class ThemeTransition {
  private readonly colors = new Map<THREE.Color, ColorTrack>();
  private readonly numbers = new Map<object, Map<PropertyKey, NumberTrack>>();
  private lastTime = performance.now() / 1000;
  private elapsed = 0;

  constructor(private readonly duration = 0.65) {}

  color(target: THREE.Color, value: THREE.ColorRepresentation) {
    const existing = this.colors.get(target);
    if (existing) existing.to.set(value);
    else this.colors.set(target, { from: target.clone(), to: new THREE.Color(value) });
  }

  number<T extends object, K extends keyof T>(target: T, key: K, value: number) {
    let properties = this.numbers.get(target);
    if (!properties) this.numbers.set(target, properties = new Map());
    const existing = properties.get(key);
    if (existing) existing.to = value;
    else properties.set(key, {
      from: Number(target[key]), to: value,
      write: (next) => { target[key] = next as T[K]; },
    });
  }

  /** Register all targets first, so lighting overrides never flash base values. */
  update(nowSeconds: number, speed = 1) {
    // Use the RAF's real clock, independent of capped physics timesteps.
    this.elapsed += Math.max(0, nowSeconds - this.lastTime) * speed;
    this.lastTime = nowSeconds;
    const elapsed = Math.min(this.duration, this.elapsed);
    const t = this.duration > 0 ? elapsed / this.duration : 1;
    // Match music-theme.css: cubic-bezier(0.4, 0, 0.2, 1). Solve its
    // horizontal coordinate so the WebGL scene and DOM use the same timing.
    let curveTime = t;
    for (let step = 0; step < 6; step++) {
      const x = ((1.6 * curveTime - 1.8) * curveTime + 1.2) * curveTime;
      const slope = (4.8 * curveTime - 3.6) * curveTime + 1.2;
      curveTime = THREE.MathUtils.clamp(curveTime - (x - t) / slope, 0, 1);
    }
    const progress = t === 1 ? 1 : curveTime * curveTime * (3 - 2 * curveTime);
    this.apply(progress);
    return elapsed >= this.duration;
  }

  finish() {
    this.apply(1);
  }

  private apply(progress: number) {
    for (const [target, { from, to }] of this.colors) {
      if (progress === 1) target.copy(to);
      else target.lerpColors(from, to, progress);
    }
    for (const properties of this.numbers.values()) for (const { from, to, write } of properties.values())
      write(progress === 1 ? to : THREE.MathUtils.lerp(from, to, progress));
  }
}
