import { followMusicMotionSpeed } from "./music-motion-ui";
import type { ArchiveNavigation } from "./archive-loop";

type MusicTickItem = { index: number; title: string };

/** Persistent slots morph independently; one shared indicator carries selection. */
export function setupMusicTicks(host: HTMLElement) {
  const slots = Array.from({ length: 12 }, (_, slot) => {
    const button = document.createElement("button");
    button.type = "button";
    button.tabIndex = -1;
    button.disabled = true;
    button.dataset.slot = String(slot);
    button.dataset.visible = "false";
    button.setAttribute("aria-hidden", "true");
    const mark = document.createElement("span");
    mark.className = "music-tick-mark";
    mark.setAttribute("aria-hidden", "true");
    button.appendChild(mark);
    return button;
  });
  const indicator = document.createElement("span");
  indicator.className = "music-tick-indicator";
  indicator.dataset.visible = "false";
  indicator.setAttribute("aria-hidden", "true");
  host.classList.add("music-ticks");
  host.replaceChildren(...slots, indicator);
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", "选择专辑");
  const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)");
  const ripples = new Map<HTMLElement, Animation>();
  let windowStart = 0,
    previousItems = "",
    activeButton: HTMLButtonElement | undefined,
    reduced = false,
    initialized = false,
    populated = false,
    scheduled = 0,
    disposed = false;

  const reconcileIndicator = () => {
    scheduled = 0;
    if (disposed || !activeButton) return;
    const width = Number.parseFloat(getComputedStyle(indicator).width) || 0;
    const x = activeButton.offsetLeft + (activeButton.offsetWidth - width) / 2;
    const direct = !initialized || reduced || reducedQuery.matches;
    if (direct) indicator.style.transition = "none";
    indicator.style.transform = `translate3d(${x}px, -50%, 0)`;
    if (direct) {
      void indicator.offsetWidth;
      indicator.style.removeProperty("transition");
    }
    initialized = activeButton.offsetWidth > 0;
  };
  const scheduleIndicator = () => {
    if (!disposed && !scheduled) scheduled = requestAnimationFrame(reconcileIndicator);
  };
  const resize = new ResizeObserver(scheduleIndicator);
  resize.observe(host);
  slots.forEach((button) => resize.observe(button));
  void document.fonts.ready.then(scheduleIndicator);
  const applyReduced = () => {
    const instant = reduced || reducedQuery.matches;
    host.dataset.reduced = String(instant);
    if (instant) {
      ripples.forEach((animation) => animation.cancel());
      ripples.clear();
    }
    scheduleIndicator();
  };
  reducedQuery.addEventListener("change", applyReduced);

  return {
    update(items: MusicTickItem[], selected: number, reduceMotion: boolean, _navigation?: ArchiveNavigation, _loop = true) {
      if (disposed) return;
      reduced = reduceMotion;
      applyReduced();
      const instant = reduced || reducedQuery.matches;
      const first = !populated;
      if (first) host.dataset.reduced = "true";
      const selectedSlot = Math.max(0, items.findIndex((item) => item.index === selected));
      const itemKey = items.map((item) => item.index).join(",");
      const groupChanged = populated && itemKey !== previousItems;
      // Recenter only when entering a genre or crossing the twelve-slot window.
      if (itemKey !== previousItems || selectedSlot < windowStart || selectedSlot >= windowStart + slots.length)
        windowStart = Math.max(0, Math.min(selectedSlot - 5, items.length - slots.length));
      previousItems = itemKey;
      const visible = items.slice(windowStart, windowStart + slots.length);
      const focused = document.activeElement;
      const style = getComputedStyle(host);
      const rest = style.getPropertyValue("--tick-rest").trim() || "10px";
      const restHeight = Number.parseFloat(rest) || 10;
      const contracted = `${restHeight * 0.6}px`;
      activeButton = undefined;
      slots.forEach((button, slot) => {
        const item = visible[slot];
        const active = item?.index === selected;
        const delay = groupChanged && !instant ? slot * 24 : 0;
        button.style.setProperty("--tick-delay", `${delay}ms`);
        button.dataset.visible = String(Boolean(item));
        button.disabled = !item;
        button.tabIndex = item ? 0 : -1;
        button.setAttribute("aria-hidden", String(!item));
        button.classList.toggle("active", active);
        button.setAttribute("aria-current", String(active));
        button.setAttribute("aria-pressed", String(active));
        if (item) {
          button.dataset.select = String(item.index);
          button.setAttribute("aria-label", `选择专辑 ${item.title}`);
          button.title = item.title;
          if (active) activeButton = button;
        } else {
          delete button.dataset.select;
          button.removeAttribute("aria-label");
          button.removeAttribute("title");
        }
        const mark = button.firstElementChild as HTMLElement;
        if (groupChanged || instant) {
          // Retarget the ripple from its displayed state during fast input.
          const current = getComputedStyle(mark);
          const from = {
            height: `${Math.min(restHeight, Number.parseFloat(current.height) || restHeight)}px`,
            opacity: Math.min(0.34, Number.parseFloat(current.opacity) || 0.28),
          };
          ripples.get(mark)?.cancel();
          ripples.delete(mark);
          if (item && !instant) {
            const animation = followMusicMotionSpeed(mark.animate([
              from,
              { height: contracted, opacity: 0.2, offset: 0.4 },
              { height: rest, opacity: 0.28 },
            ], { duration: 560, delay, easing: "cubic-bezier(.22,.65,.28,1)", fill: "backwards" }));
            ripples.set(mark, animation);
            animation.onfinish = () => {
              if (ripples.get(mark) === animation) ripples.delete(mark);
            };
          }
        }
      });
      indicator.dataset.visible = String(Boolean(activeButton));
      if (!activeButton) initialized = false;
      if (first) {
        void host.offsetWidth;
        populated = items.length > 0;
        applyReduced();
      }
      scheduleIndicator();
      // Exiting slots stay visible during collapse but become inaccessible now.
      if (slots.some((button) => button === focused && button.disabled))
        (activeButton || slots.find((button) => !button.disabled))?.focus({ preventScroll: true });
    },
    destroy() {
      disposed = true;
      resize.disconnect();
      reducedQuery.removeEventListener("change", applyReduced);
      cancelAnimationFrame(scheduled);
      ripples.forEach((animation) => animation.cancel());
      ripples.clear();
    },
  };
}
