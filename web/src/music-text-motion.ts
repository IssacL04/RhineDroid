import {
  createRollingNumber,
  createRollingText,
} from "@kitlangton/rolling-number";
import type { ArchiveNavigation } from "./archive-loop";
import { musicMotionDuration } from "./music-motion-settings";
import { followRollingMotionSpeed } from "./music-motion-ui";

type SelectionText = {
  number: number;
  total: number;
  code: number;
  genreIndex: number;
  genresTotal: number;
  genre: string;
  genreName: string;
  format: string;
  artist: string;
  meta: string;
};

/** Keep the original archive's per-glyph reels alive across selection changes. */
export function setupMusicTextMotion(root: HTMLElement) {
  const reelHosts: HTMLElement[] = [];
  const host = (id: string, kind: "text" | "number") => {
    const element = root.querySelector<HTMLElement>(`#${id}`)!;
    element.classList.add(`music-rolling-${kind}`);
    reelHosts.push(element);
    return element;
  };
  const motion = {
    duration: musicMotionDuration(460),
    motionBlur: false,
    animated: false,
    // Hidden browse text is prepared before the camera finishes its return.
    pauseOffscreen: false,
  };
  const pendingWraps = new Set<() => () => void>();
  let wrappingFrame = 0;
  const flushWrapping = () => {
    wrappingFrame = 0;
    // Read both metadata blocks before changing either reel's DOM/display.
    const commits = [...pendingWraps].map((read) => read());
    pendingWraps.clear();
    commits.forEach((commit) => commit());
  };
  const queueWrapping = (read: () => () => void) => {
    pendingWraps.add(read);
    if (!wrappingFrame) wrappingFrame = requestAnimationFrame(flushWrapping);
  };
  const number = (id: string, digits = 2) =>
    createRollingNumber(host(id, "number"), {
      ...motion,
      value: 1,
      locales: "en-US",
      format: { minimumIntegerDigits: digits, useGrouping: false },
    });
  const text = (id: string) =>
    createRollingText(host(id, "text"), {
      ...motion,
      text: "",
      transition: "direct",
      stagger: "none",
      direction: "up",
    });
  const wrappingText = (id: string) => {
    // Auxiliary metadata keeps its native block width. Reels only own the
    // inner single-line span; longer artist lists retain ordinary line wraps.
    const element = root.querySelector<HTMLElement>(`#${id}`)!;
    const reel = document.createElement("span");
    const plain = document.createElement("span");
    const measure = document.createElement("span");
    reel.className = "music-rolling-text music-inline-reel";
    reelHosts.push(reel);
    plain.className = "music-inline-plain";
    plain.style.display = "none";
    plain.style.whiteSpace = "normal";
    plain.style.overflowWrap = "anywhere";
    measure.setAttribute("aria-hidden", "true");
    measure.style.cssText =
      "position:absolute;visibility:hidden;pointer-events:none;white-space:pre;width:max-content;max-width:none;";
    element.replaceChildren(reel, plain, measure);
    const controller = createRollingText(reel, {
      ...motion,
      text: "",
      transition: "direct",
      stagger: "none",
      direction: "up",
    });
    let value = "",
      animated = false,
      usingReel = true,
      measured = false,
      disposed = false;
    const readLayout = () => {
      if (disposed) return () => {};
      const style = getComputedStyle(element);
      const available =
        element.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      const fits = available > 0 && measure.scrollWidth <= available;
      return () => {
        const previouslyUsingReel = usingReel;
        usingReel = fits;
        if (!measured || fits !== previouslyUsingReel) {
          // Inline display overrides the library's .rn-root rule while hidden.
          reel.style.display = fits ? "inline-block" : "none";
          plain.style.display = fits ? "none" : "inline";
        }
        measured = true;
        controller.update({
          text: value,
          animated: animated && fits && previouslyUsingReel,
        });
        if (fits && !previouslyUsingReel) controller.update({ animated });
      };
    };
    const schedule = () => {
      if (!disposed) queueWrapping(readLayout);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    document.fonts.addEventListener("loadingdone", schedule);
    void document.fonts.ready.then(schedule);
    return {
      update(options: { text?: string; animated?: boolean; duration?: number }) {
        if (options.duration !== undefined) controller.update({ duration: options.duration });
        let changedText = false;
        if (options.text !== undefined && options.text !== value) {
          changedText = true;
          value = options.text;
          element.title = value;
          plain.textContent = value;
          measure.textContent = value;
        }
        const changedMotion =
          options.animated !== undefined && options.animated !== animated;
        if (options.animated !== undefined) animated = options.animated;
        if (changedText || !measured) schedule();
        // Enabling the already measured current text needs no geometry reads.
        else if (changedMotion)
          controller.update({ animated: animated && usingReel });
      },
      finish() {
        animated = false;
        controller.update({ animated: false });
      },
      destroy() {
        disposed = true;
        resize.disconnect();
        document.fonts.removeEventListener("loadingdone", schedule);
        pendingWraps.delete(readLayout);
        controller.destroy();
        element.textContent = value;
      },
    };
  };
  const numbers = {
    number: number("selection-number"),
    total: number("selection-total"),
    code: number("selection-code-number", 3),
    genreIndex: number("genre-index"),
    genresTotal: number("genre-total"),
  };
  const texts = {
    genre: text("selection-genre"),
    genreName: text("genre-name"),
    format: text("selection-format"),
    artist: wrappingText("selection-artist"),
    meta: wrappingText("selection-meta"),
  };
  const controllers = [...Object.values(numbers), ...Object.values(texts)];
  const unsubscribeSpeed = followRollingMotionSpeed(reelHosts, () => {
    const duration = musicMotionDuration(460);
    controllers.forEach((controller) => controller.update({ duration }));
  });
  let enabled = false;
  const setEnabled = (next: boolean) => {
    if (enabled === next) return;
    enabled = next;
    // Prepare the current glyphs before the next input, so the first selection
    // after entering the archive animates just like subsequent selections.
    controllers.forEach((controller) => controller.update({ animated: next }));
  };
  return {
    setEnabled,
    update(
      value: SelectionText,
      animated: boolean,
      navigation?: ArchiveNavigation,
    ) {
      setEnabled(animated);
      const axis =
        navigation && "axis" in navigation ? navigation.axis : undefined;
      const direction =
        navigation && "axis" in navigation
          ? navigation.direction > 0
            ? "up"
            : "down"
          : "auto";
      numbers.number.update({
        value: value.number,
        direction: axis === "row" ? direction : "auto",
      });
      numbers.total.update({
        value: value.total,
        direction: axis === "lane" ? direction : "auto",
      });
      numbers.code.update({ value: value.code, direction });
      numbers.genreIndex.update({
        value: value.genreIndex,
        direction: axis === "lane" ? direction : "auto",
      });
      numbers.genresTotal.update({
        value: value.genresTotal,
        direction: "auto",
      });
      for (const key of Object.keys(texts) as (keyof typeof texts)[])
        texts[key].update({ text: value[key] });
    },
    finish() {
      setEnabled(false);
    },
    destroy() {
      unsubscribeSpeed();
      cancelAnimationFrame(wrappingFrame);
      pendingWraps.clear();
      controllers.forEach((controller) => controller.destroy());
    },
  };
}
