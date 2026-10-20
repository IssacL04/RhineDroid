import { createRollingText } from "@kitlangton/rolling-number";
import { musicMotionDuration } from "./music-motion-settings";
import { followRollingMotionSpeed } from "./music-motion-ui";

/** Keep one interruptible archive-style reel while the outer playback slot grows. */
export function setupTransportTitle(slot: HTMLButtonElement, label: HTMLElement) {
  const measure = document.createElement("span");
  measure.className = "transport-title-measure";
  measure.setAttribute("aria-hidden", "true");
  const ellipsisMeasure = document.createElement("span");
  ellipsisMeasure.className = "transport-title-ellipsis";
  ellipsisMeasure.setAttribute("aria-hidden", "true");
  ellipsisMeasure.textContent = "…";
  const reel = document.createElement("span");
  reel.className = "transport-title-reel";
  reel.setAttribute("aria-hidden", "true");
  label.replaceChildren(measure, ellipsisMeasure, reel);
  const controller = createRollingText(reel, {
    text: "",
    duration: musicMotionDuration(460),
    motionBlur: true,
    transition: "direct",
    stagger: "none",
    direction: "up",
    animated: false,
  });
  const unsubscribeSpeed = followRollingMotionSpeed([reel], () => {
    controller.update({ duration: musicMotionDuration(460) });
  });
  const segmenter = typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;
  let glyphs: string[] = [];
  let title = "", displayed = "", font = "";
  let visible = false, reduced = false, disposed = false, scheduled = 0;

  const reconcile = (animate = false) => {
    if (disposed) return;
    const style = getComputedStyle(label);
    const nextFont = [style.font, style.letterSpacing, style.fontFeatureSettings,
      style.fontVariationSettings].join(";");
    const padding = (Number.parseFloat(style.paddingLeft) || 0) +
      (Number.parseFloat(style.paddingRight) || 0);
    // The reel measures separate grapheme spans in a flex row. Whole-string
    // canvas/native text can be narrower because of kerning and ligatures.
    const widths = Array.from(measure.children, child => child.getBoundingClientRect().width);
    const naturalWidth = measure.getBoundingClientRect().width;
    slot.style.setProperty("--song-width", `${Math.ceil(naturalWidth + padding) + 14}px`);
    const available = Math.max(0, label.getBoundingClientRect().width - padding);
    let fitted = title;
    if (naturalWidth > available) {
      const ellipsisWidth = ellipsisMeasure.getBoundingClientRect().width;
      let length = 0, width = ellipsisWidth;
      while (length < glyphs.length && width + widths[length] <= available) {
        width += widths[length++];
      }
      fitted = ellipsisWidth <= available ? `${glyphs.slice(0, length).join("")}…` : "";
    }
    // ResizeObserver also fires after a title change; don't restart that roll.
    if (fitted === displayed && nextFont === font) return;
    const fontChanged = font !== nextFont;
    displayed = fitted;
    font = nextFont;
    controller.update({ animated: animate && visible && !reduced });
    controller.update({ text: fitted });
    if (fontChanged) controller.refresh();
    controller.update({ animated: visible && !reduced });
  };
  const schedule = () => {
    if (!scheduled && !disposed) scheduled = requestAnimationFrame(() => {
      scheduled = 0;
      reconcile();
    });
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(label);
  resize.observe(measure);
  document.fonts.addEventListener("loadingdone", schedule);
  void document.fonts.ready.then(schedule);

  return {
    setReduced(next: boolean) {
      reduced = next;
      controller.update({ animated: visible && !reduced });
      if (reduced) controller.finish();
    },
    update(next: string, shown: boolean) {
      const wasVisible = visible;
      const changed = shown && next !== title;
      visible = shown;
      slot.classList.toggle("visible", shown);
      slot.setAttribute("aria-hidden", String(!shown));
      slot.disabled = !shown;
      if (changed) {
        title = next;
        glyphs = segmenter ? Array.from(segmenter.segment(title), item => item.segment) : [...title];
        measure.replaceChildren(...glyphs.map(glyph => {
          const span = document.createElement("span");
          span.textContent = glyph;
          return span;
        }));
        slot.title = `定位歌曲：${title}`;
        slot.setAttribute("aria-label", `定位歌曲：${title}`);
        reconcile(wasVisible);
      }
      if (shown !== wasVisible) controller.update({ animated: shown && !reduced });
    },
    destroy() {
      unsubscribeSpeed();
      disposed = true;
      resize.disconnect();
      document.fonts.removeEventListener("loadingdone", schedule);
      cancelAnimationFrame(scheduled);
      controller.destroy();
      label.textContent = title;
    },
  };
}
