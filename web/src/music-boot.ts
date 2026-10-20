import "./music-boot.css";
import { MusicBootFrameClock, MUSIC_BOOT_END_TIME, MUSIC_BOOT_SCENE_REVEAL_TIME, musicBootSceneTime } from "./music-boot-timing.ts";
import { MusicOpening, MUSIC_OPENING_SLOGAN, musicOpeningFrame } from "./music-opening";

const REVEAL_DURATION = 720;
const REVEAL_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const ease = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};
export interface MusicBootFrame {
  cinema: { reveal: number; lift: number; zoom: number; time: number; musicIntro: true };
  renderScene: boolean;
  phase: "logo" | "orbit" | "slogan" | "array" | "select";
  appTime: number;
}
export interface MusicBootOptions {
  onStart?: () => void;
  onComplete?: (reason: "complete" | "skip") => void;
  reduced?: boolean | (() => boolean);
  album?: () => { title: string; artist?: string } | null | undefined;
}
type SavedSibling = {
  node: HTMLElement;
  inert: boolean;
  visibility: string;
  priority: string;
};

/** A frame-driven music prologue followed by the original live scene. */
export class MusicBoot {
  readonly root: HTMLElement;
  private readonly opening: MusicOpening;
  private readonly frameClock = new MusicBootFrameClock();
  private running = false;
  private revealing = false;
  private revealRevision = 0;
  private revealAnimations: Animation[] = [];
  private revealFocus: HTMLElement | null = null;
  private endpointRendered = false;
  private disposed = false;
  private siblings: SavedSibling[] = [];
  private opener: HTMLElement | null = null;

  constructor(private parent: HTMLElement, private options: MusicBootOptions = {}) {
    this.root = document.createElement("section");
    this.root.className = "music-boot-overlay";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", `音乐开场：${MUSIC_OPENING_SLOGAN}`);
    this.root.tabIndex = -1;
    this.opening = new MusicOpening(this.root);
    this.parent.appendChild(this.root);
    this.root.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (this.revealing) {
        event.preventDefault();
        return;
      }
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        this.skip();
      } else if (event.key === "Tab") {
        event.preventDefault();
        this.root.focus({ preventScroll: true });
      }
    });
  }
  get active() { return this.running || this.revealing; }

  start(nowSeconds = performance.now() / 1000, _forceMotion = false) {
    if (this.disposed) return;
    if (!Number.isFinite(nowSeconds)) nowSeconds = performance.now() / 1000;
    if (this.revealing) this.completeReveal(false);
    if (!this.running) {
      this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.siblings = [...this.parent.children]
        .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== this.root)
        // Keep the same brand and nested controls, restoring their original states at handoff.
        .flatMap((node) => node.classList.contains("music-header")
          ? [node, ...[...node.children].filter((child): child is HTMLElement =>
            child instanceof HTMLElement && !child.classList.contains("music-identity"))]
          : [node])
        .map((node) => ({ node, inert: node.inert,
          visibility: node.style.getPropertyValue("visibility"),
          priority: node.style.getPropertyPriority("visibility") }));
      for (const { node } of this.siblings) {
        node.inert = true;
        if (!node.classList.contains("three-scene"))
          node.style.setProperty("visibility", "hidden");
      }
    }
    this.running = true;
    this.endpointRendered = false;
    this.parent.dataset.musicBoot = "running";
    this.frameClock.reset(nowSeconds);
    this.opening.update(0);
    this.root.hidden = false;
    this.root.setAttribute("aria-label", `音乐开场：${MUSIC_OPENING_SLOGAN}`);
    this.options.onStart?.();
    const reduced = typeof this.options.reduced === "function" ? this.options.reduced() : this.options.reduced;
    if (reduced) { this.skip(); return; }
    this.root.focus({ preventScroll: true });
  }
  replay(nowSeconds = performance.now() / 1000) { this.start(nowSeconds); }
  skip() { if (this.running && !this.disposed) this.finish("skip"); }

  update(nowSeconds: number): MusicBootFrame | undefined {
    if (this.revealing && this.isReduced()) this.completeReveal();
    if (!this.running || this.disposed || !Number.isFinite(nowSeconds)) return;
    if (this.isReduced()) { this.skip(); return; }
    if (this.endpointRendered) { this.finish("complete"); return; }
    const appTime = this.frameClock.update(nowSeconds);
    this.endpointRendered = appTime === MUSIC_BOOT_END_TIME;
    this.opening.update(appTime);
    const sceneTime = musicBootSceneTime(appTime);
    const phase = sceneTime >= 25.68 ? "select" : musicOpeningFrame(appTime).phase;
    this.root.dataset.phase = phase;
    this.root.dataset.appTime = String(appTime);
    return {
      appTime, phase, renderScene: appTime >= MUSIC_BOOT_SCENE_REVEAL_TIME,
      cinema: {
        reveal: ease((sceneTime - 21.9) / 0.13),
        lift: 0,
        zoom: 0,
        time: sceneTime,
        musicIntro: true,
      },
    };
  }
  private finish(reason: "complete" | "skip", notify = true) {
    this.running = false;
    this.opening.root.hidden = true;
    this.root.hidden = true;
    for (const { node, inert, visibility, priority } of this.siblings) {
      node.inert = inert;
      if (visibility) node.style.setProperty("visibility", visibility, priority);
      else node.style.removeProperty("visibility");
    }
    // The completion hook owns the camera endpoint and browse surface fade. It
    // must run while active is false so showBrowseSurface can start normally.
    if (notify) this.options.onComplete?.(reason);
    this.revealFocus = document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body && !this.root.contains(document.activeElement)
      ? document.activeElement : this.opener;
    if (!notify || this.isReduced()) {
      this.siblings = [];
      this.parent.dataset.musicBoot = "done";
      if (notify) this.restoreFocus();
      return;
    }

    // Snapshot the hook's final interaction state, then keep the whole stage
    // locked until the controls are visible. All of this happens before paint.
    for (const sibling of this.siblings) {
      sibling.inert = sibling.node.inert;
      sibling.node.inert = true;
    }
    this.revealing = true;
    this.parent.dataset.musicBoot = "revealing";
    this.root.hidden = false;
    this.root.setAttribute("aria-label", "正在显示音乐库");
    this.root.focus({ preventScroll: true });
    const revision = ++this.revealRevision;
    const fade = (selector: string, delay = 0) => {
      const node = this.parent.querySelector<HTMLElement>(selector);
      if (!node || node.hidden) return;
      this.revealAnimations.push(node.animate(
        [{ opacity: 0 }, { opacity: getComputedStyle(node).opacity }],
        { duration: REVEAL_DURATION - delay, delay, easing: REVEAL_EASE, fill: "both" },
      ));
    };
    fade(".music-vignette");
    fade(".music-identity");
    fade(".music-topnav");
    fade(".library-status", 45);
    fade(".music-bottomline", 90);
    fade(".music-empty", 60);
    // SurfaceTransition owns the navigation container's opacity. Stagger its
    // inner groups so the intro never reads/overrides that in-flight fade.
    for (const selector of [".music-counter", ".album-stepper", ".genre-stepper"])
      fade(selector, 110);
    // Keep navigation geometry stable for the title's bottom clearance. Move
    // callout/keyhint with independent translate, preserving existing transforms.
    for (const [selector, delay] of [
      [".album-callout", 60], [".music-keyhint", 140],
    ] as const) {
      const node = this.parent.querySelector<HTMLElement>(selector);
      if (!node) continue;
      this.revealAnimations.push(node.animate(
        [{ translate: "0 8px" }, { translate: getComputedStyle(node).translate }],
        { duration: REVEAL_DURATION - delay, delay, easing: REVEAL_EASE, fill: "both" },
      ));
    }
    void Promise.all(this.revealAnimations.map((animation) => animation.finished))
      .then(() => {
        if (revision === this.revealRevision && !this.disposed) this.completeReveal();
      }).catch(() => {});
  }
  private isReduced() {
    return typeof this.options.reduced === "function" ? this.options.reduced() : this.options.reduced;
  }
  private restoreFocus() {
    if (this.revealFocus?.isConnected && !this.revealFocus.closest("[inert], [hidden]"))
      this.revealFocus.focus({ preventScroll: true });
    this.revealFocus = null;
  }
  private completeReveal(restoreFocus = true) {
    this.revealRevision++;
    this.revealAnimations.forEach((animation) => animation.cancel());
    this.revealAnimations = [];
    this.revealing = false;
    this.root.hidden = true;
    this.parent.dataset.musicBoot = "done";
    for (const { node, inert } of this.siblings) node.inert = inert;
    this.siblings = [];
    if (restoreFocus) this.restoreFocus();
    else this.revealFocus = null;
  }
  dispose() {
    if (this.disposed) return;
    if (this.running) this.finish("skip", false);
    if (this.revealing) this.completeReveal(false);
    this.disposed = true;
    this.root.remove();
  }
}
