/** Keep wheel input in the current column and reuse the ordinary album motion. */
export type MusicWheelInput = Pick<
  WheelEvent,
  "deltaMode" | "deltaX" | "deltaY" | "ctrlKey" | "shiftKey"
>;

const PIXELS_PER_ALBUM = 48;
const MAX_ALBUMS_PER_EVENT = 3;
const GESTURE_GAP_MS = 200;

export function musicWheelDelta(event: MusicWheelInput, pageHeight: number) {
  // Read deltaMode before the deltas: some browsers adapt their units when
  // callers inspect it. Pinch-to-zoom and horizontal gestures keep their owner.
  const unit =
    event.deltaMode === 1
      ? 16
      : event.deltaMode === 2
        ? Math.max(1, pageHeight)
        : 1;
  if (
    event.ctrlKey ||
    event.shiftKey ||
    !Number.isFinite(event.deltaY) ||
    !Number.isFinite(event.deltaX) ||
    Math.abs(event.deltaX) >= Math.abs(event.deltaY)
  )
    return 0;
  return event.deltaY * unit;
}

export class MusicWheelSteps {
  private remainder = 0;
  private direction = 0;
  private lastTime = -Infinity;

  reset() {
    this.remainder = 0;
    this.direction = 0;
    this.lastTime = -Infinity;
  }

  consume(delta: number, now: number) {
    if (!Number.isFinite(delta) || !delta) return 0;
    const direction = Math.sign(delta);
    if (
      now - this.lastTime > GESTURE_GAP_MS ||
      now < this.lastTime ||
      direction !== this.direction
    ) {
      this.remainder = 0;
    }
    this.lastTime = now;
    this.direction = direction;
    // Accumulate small trackpad deltas, while a single oversized wheel/page
    // event can never jump dozens of albums or leave a delayed input backlog.
    this.remainder +=
      Math.min(Math.abs(delta), PIXELS_PER_ALBUM * MAX_ALBUMS_PER_EVENT) *
      direction;
    const steps = Math.trunc(this.remainder / PIXELS_PER_ALBUM);
    this.remainder -= steps * PIXELS_PER_ALBUM;
    return steps || 0;
  }
}

type MusicWheelOptions = {
  enabled: () => boolean;
  navigate: (direction: number) => void;
  /** A column identity, so a partial gesture cannot leak into another singer. */
  context?: () => string | number;
};

const NATIVE_WHEEL_TARGETS = [
  "input",
  "textarea",
  "select",
  "button",
  "a",
  "[contenteditable]:not([contenteditable=false])",
  "dialog",
  "[role=dialog]",
  "[role=slider]",
  ".music-panel-scrim",
  "#music-detail",
  ".lighting-lab",
  ".animation-lab",
  "[data-developer-panel]",
].join(",");

function keepsNativeWheel(target: EventTarget | null, stage: HTMLElement) {
  if (!(target instanceof Element)) return true;
  if (target.closest(NATIVE_WHEEL_TARGETS)) return true;
  // Keep native scroll ownership even at a pane's top/bottom boundary. This
  // also protects future scrollable content without a special class name.
  for (
    let element: Element | null = target;
    element && element !== stage;
    element = element.parentElement
  ) {
    if (element.scrollHeight <= element.clientHeight + 1) continue;
    const overflow = getComputedStyle(element).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay")
      return true;
  }
  return false;
}

export function mountMusicWheelNavigation(
  stage: HTMLElement,
  options: MusicWheelOptions,
) {
  const steps = new MusicWheelSteps();
  let context: string | number | undefined;
  const reset = () => steps.reset();
  const onWheel = (event: WheelEvent) => {
    if (
      event.defaultPrevented ||
      !options.enabled() ||
      keepsNativeWheel(event.target, stage)
    ) {
      reset();
      return;
    }
    const delta = musicWheelDelta(event, stage.clientHeight);
    if (!delta) {
      reset();
      return;
    }
    const nextContext = options.context?.();
    if (nextContext !== context) reset();
    context = nextContext;
    event.preventDefault();
    const direction = steps.consume(delta, performance.now());
    if (direction) options.navigate(direction);
  };
  // Bubble only: controls can retain wheel ownership with stopPropagation.
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("pointerdown", reset, { passive: true });
  stage.addEventListener("keydown", reset);
  window.addEventListener("blur", reset);
  return {
    reset,
    dispose() {
      reset();
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("pointerdown", reset);
      stage.removeEventListener("keydown", reset);
      window.removeEventListener("blur", reset);
    },
  };
}
