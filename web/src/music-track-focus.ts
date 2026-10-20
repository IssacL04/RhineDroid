/** One cancellable track reveal, scoped to the detail pane rather than the page. */
export class MusicTrackFocus {
  private cleanup?: () => void;

  cancel() {
    this.cleanup?.();
  }

  reveal(container: HTMLElement, row: HTMLButtonElement, reduced: boolean) {
    this.cancel();
    let frame = 0;
    let pulse: Animation | undefined;
    let hold: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const cancel = () => {
      if (!active) return;
      active = false;
      cancelAnimationFrame(frame);
      pulse?.cancel();
      clearTimeout(hold);
      row.classList.remove("search-track-highlight");
      container.removeEventListener("wheel", cancel);
      container.removeEventListener("pointerdown", cancel);
      container.removeEventListener("touchstart", cancel);
      container.removeEventListener("keydown", cancel);
      window.removeEventListener("resize", cancel);
      this.cleanup = undefined;
    };
    this.cleanup = cancel;
    // A user's own scroll or click always takes precedence over reveal motion.
    container.addEventListener("wheel", cancel, { passive: true });
    container.addEventListener("pointerdown", cancel, { passive: true });
    container.addEventListener("touchstart", cancel, { passive: true });
    container.addEventListener("keydown", cancel);
    window.addEventListener("resize", cancel);

    const tabsHeight = container.querySelector<HTMLElement>(".music-tabs")?.offsetHeight ?? 0;
    const start = container.scrollTop;
    const rowTop = row.getBoundingClientRect().top - container.getBoundingClientRect().top + start;
    const centerOffset = tabsHeight + Math.max(0, (container.clientHeight - tabsHeight - row.offsetHeight) / 2);
    const target = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, rowTop - centerOffset));
    const highlight = () => {
      if (!active || !row.isConnected) { cancel(); return; }
      row.focus({ preventScroll: true });
      if (reduced) {
        row.classList.add("search-track-highlight");
        hold = setTimeout(cancel, 1100);
      } else {
        pulse = row.animate([
          { backgroundColor: "transparent", boxShadow: "inset 3px 0 transparent", offset: 0, easing: "ease-in-out" },
          { backgroundColor: "var(--search-track-tint)", boxShadow: "inset 3px 0 var(--accent)", offset: 0.32 },
          { backgroundColor: "var(--search-track-tint)", boxShadow: "inset 3px 0 var(--accent)", offset: 0.48, easing: "ease-in-out" },
          { backgroundColor: "transparent", boxShadow: "inset 3px 0 transparent", offset: 0.88 },
          { backgroundColor: "transparent", boxShadow: "inset 3px 0 transparent", offset: 1 },
        ], { duration: 1000, iterations: 2 });
        pulse.onfinish = cancel;
      }
    };
    if (reduced || Math.abs(target - start) < 1) {
      container.scrollTop = target;
      highlight();
      return;
    }
    const duration = Math.min(700, 320 + Math.abs(target - start) * 0.12);
    const started = performance.now();
    const scroll = (now: number) => {
      if (!active || !row.isConnected) { cancel(); return; }
      const progress = Math.min(1, (now - started) / duration);
      const eased = progress < 0.5
        ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
      container.scrollTop = start + (target - start) * eased;
      if (progress < 1) frame = requestAnimationFrame(scroll);
      else highlight();
    };
    frame = requestAnimationFrame(scroll);
  }
}
