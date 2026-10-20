import type { DecryptionFrame } from "./decryption";

type Cover = { window: HTMLElement; ink: HTMLElement; order: number };

/** Decorative redaction, driven by the physical archive's reveal cue. */
export class DocumentDecryption {
  constructor(
    private selector = "h2, .detail-title-cn, .metadata dd, .tab-panel p, .research-notes li, .log-row",
    private holdSeconds?: number,
  ) {}
  private root: HTMLElement | null = null;
  private covers: Cover[] = [];
  private started: number | null = null;
  private visibleSince: number | null = null;
  private progress = 0;

  reset(root: HTMLElement, clear: boolean) {
    this.remove();
    this.root = root;
    this.started = null;
    this.visibleSince = null;
    this.progress = clear ? 1 : 0;
    this.refresh();
  }

  refresh() {
    this.remove();
    if (!this.root || this.progress === 1) return;
    // Measure text fragments, including wrapped lines, without splitting or
    // replacing the actual text. Stage scaling cancels out in local coordinates.
    const targets = this.root.querySelectorAll<HTMLElement>(this.selector);
    targets.forEach((target) => {
      target.classList.add("document-redacted");
      const bounds = target.getBoundingClientRect();
      const scale = bounds.width / target.offsetWidth;
      if (!scale || !Number.isFinite(scale)) return;
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      const lines: { x: number; y: number; right: number; bottom: number }[] =
        [];
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (!rect.width || !rect.height) continue;
          const x = (rect.left - bounds.left) / scale;
          const y = (rect.top - bounds.top) / scale;
          const right = (rect.right - bounds.left) / scale;
          const bottom = (rect.bottom - bounds.top) / scale;
          const line = lines.find((entry) => Math.abs(entry.y - y) < 6);
          if (line) {
            line.x = Math.min(line.x, x);
            line.y = Math.min(line.y, y);
            line.right = Math.max(line.right, right);
            line.bottom = Math.max(line.bottom, bottom);
          } else lines.push({ x, y, right, bottom });
        }
      }
      for (const line of lines) {
        const window = document.createElement("span");
        window.className = "document-redaction-window";
        window.setAttribute("aria-hidden", "true");
        const left = Math.max(0, line.x - 1);
        const right = Math.min(target.clientWidth, line.right + 1);
        window.style.cssText = `left:${left}px;top:${line.y - 1}px;width:${right - left}px;height:${line.bottom - line.y + 2}px`;
        const ink = document.createElement("span");
        ink.className = "document-redaction-ink";
        window.append(ink);
        target.append(window);
        this.covers.push({ window, ink, order: this.covers.length });
      }
    });
    this.paint();
  }

  update(
    now: number,
    frame: DecryptionFrame,
    reduced: boolean,
    visible = true,
  ) {
    if (!this.root || this.progress === 1) return;
    if (reduced) this.progress = 1;
    else {
      if (this.started === null) {
        if (this.holdSeconds !== undefined) {
          // Music mode shortens only the still hold after the text becomes
          // visible. The 0.95 s sweep and each line's easing remain unchanged.
          if (visible && this.visibleSince === null) this.visibleSince = now;
          if (
            this.visibleSince !== null &&
            now >= this.visibleSince + this.holdSeconds
          )
            this.started = this.visibleSince + this.holdSeconds;
        } else if (frame.clarity > 0) this.started = now;
      }
      if (this.started !== null)
        this.progress = Math.min(1, Math.max(0, (now - this.started) / 0.95));
    }
    if (this.progress === 1) this.remove();
    else if (this.started !== null) this.paint();
  }

  private paint() {
    const count = Math.max(1, this.covers.length - 1);
    for (const cover of this.covers) {
      const delay = (cover.order / count) * 0.22;
      const t = Math.min(1, Math.max(0, (this.progress - delay) / 0.78));
      // Brief acceleration, decisive departure, long deceleration; no bounce.
      const eased =
        t < 0.2 ? 0.4 * (t / 0.2) ** 2 : 1 - 0.6 * ((1 - t) / 0.8) ** (16 / 3);
      cover.ink.style.transform = `translateX(${eased * 101}%)`;
    }
  }

  private remove() {
    for (const cover of this.covers) cover.window.remove();
    this.covers = [];
  }
}
