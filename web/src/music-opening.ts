import { androidHeadPath, bootMarkContour } from "./brand";
import { MUSIC_BOOT_SCENE_START, MUSIC_BOOT_SCENE_REVEAL_TIME } from "./music-boot-timing";

export const MUSIC_OPENING_SLOGAN = "一张一张，慢慢听";
const unit = (time: number, from: number, to: number) =>
  Math.max(0, Math.min(1, (time - from) / (to - from)));
const smooth = (t: number) => t * t * (3 - 2 * t);
const settle = (t: number) => 1 - (1 - t) ** 3;

/** Independent tracks: mark → orbit → readable phrase → live collection.
 * Everything samples the bounded film clock, never a CSS/wall-clock timer. */
export function musicOpeningFrame(time: number) {
  const t = Number.isFinite(time) ? Math.max(0, time) : 0;
  const titleIn = settle(unit(t, 2.64, 3.02));
  const titleOut = smooth(unit(t, 3.58, 4));
  const phase: "logo" | "orbit" | "slogan" | "array" =
    t < 1.8 ? "logo" : t < 2.64 ? "orbit" : t < MUSIC_BOOT_SCENE_START ? "slogan" : "array";
  return {
    phase,
    background: 1 - smooth(unit(t, MUSIC_BOOT_SCENE_REVEAL_TIME, 4.38)),
    mark: smooth(unit(t, 0.2, 0.48)) * (1 - smooth(unit(t, 1.8, 2.26))),
    contour: settle(unit(t, 0.24, 1.64)),
    symbols: settle(unit(t, 0.84, 1.5)),
    orbit: smooth(unit(t, 1.64, 2.05)) * (1 - smooth(unit(t, 2.78, 3.28))),
    orbitDraw: settle(unit(t, 1.64, 2.82)),
    orbitTurn: 190 * smooth(unit(t, 1.64, 3.3)),
    orbitScale: 0.9 + 0.1 * settle(unit(t, 1.64, 2.8)),
    title: titleIn * (1 - titleOut),
    titleY: 18 * (1 - titleIn) - 8 * titleOut,
    titleClip: 100 * (1 - titleIn),
    subtitle: smooth(unit(t, 2.82, 3.16)) * (1 - smooth(unit(t, 3.56, 4))),
  };
}

export class MusicOpening {
  readonly root = document.createElement("div");
  private readonly nodes: Record<string, HTMLElement | SVGElement>;

  constructor(parent: HTMLElement) {
    this.root.className = "music-opening";
    this.root.setAttribute("aria-hidden", "true");
    this.root.innerHTML = `
      <div class="music-opening-paper" data-opening="paper"></div>
      <div class="music-opening-mark" data-opening="mark">
        <svg viewBox="0 64 856 192" aria-hidden="true"><g transform="translate(80 78) scale(1.15)"><path data-opening="contour" d="${bootMarkContour}" pathLength="1" fill="none" stroke="currentColor" stroke-width="18"/><g data-opening="symbols" fill="none" stroke="currentColor" stroke-width="11"><path d="M44 70h50M69 45v50M219 70h44"/></g></g><g class="music-opening-android" transform="translate(476 8) scale(13)" fill="currentColor"><path d="${androidHeadPath}"/></g></svg>
        <span>RhineDroid</span>
      </div>
      <div class="music-opening-orbit" data-opening="orbit">
        <svg viewBox="0 0 520 520" aria-hidden="true"><g data-opening="orbit-turn" fill="none" stroke="currentColor" stroke-width="1.2"><circle data-opening="orbit-line" cx="260" cy="260" r="236" pathLength="1"/><circle cx="260" cy="260" r="207" stroke-dasharray="142 91 380 95"/><circle cx="260" cy="24" r="4" fill="currentColor" stroke="none"/><circle cx="260" cy="496" r="4" fill="var(--accent)" stroke="none"/></g><path d="M252 260h16M260 252v16" stroke="currentColor" stroke-width="1.1"/></svg>
      </div>
      <div class="music-opening-statement"><p data-opening="title">${MUSIC_OPENING_SLOGAN}</p><span data-opening="subtitle">ONE ALBUM AT A TIME</span></div>`;
    parent.appendChild(this.root);
    this.nodes = Object.fromEntries(["paper", "mark", "contour", "symbols", "orbit", "orbit-turn", "orbit-line", "title", "subtitle"]
      .map((name) => [name, this.root.querySelector<HTMLElement | SVGElement>(`[data-opening="${name}"]`)!]));
    this.update(0);
  }

  update(time: number) {
    const frame = musicOpeningFrame(time);
    this.root.hidden = frame.background === 0;
    this.root.dataset.phase = frame.phase;
    const opacity = (name: string, value: number) => { this.nodes[name].style.opacity = String(value); };
    opacity("paper", frame.background);
    opacity("mark", frame.mark);
    this.nodes.contour.style.strokeDasharray = `${frame.contour} 1`;
    opacity("symbols", frame.symbols);
    opacity("orbit", frame.orbit);
    this.nodes.orbit.style.transform = `translate(-50%, -50%) scale(${frame.orbitScale})`;
    this.nodes["orbit-turn"].setAttribute("transform", `rotate(${frame.orbitTurn} 260 260)`);
    this.nodes["orbit-line"].style.strokeDasharray = `${frame.orbitDraw} 1`;
    opacity("title", frame.title);
    this.nodes.title.style.transform = `translateY(${frame.titleY}px)`;
    this.nodes.title.style.clipPath = `inset(0 0 ${frame.titleClip}% 0)`;
    opacity("subtitle", frame.subtitle);
  }
}
