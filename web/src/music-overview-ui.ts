import { visibleOverviewLabels, type OverviewColumn } from "./music-overview";
import { SurfaceTransition } from "./ui-transitions";

interface LabelSurface {
  anchor: HTMLDivElement;
  card: HTMLDivElement;
  label: HTMLButtonElement;
  enter: HTMLButtonElement;
  transition: SurfaceTransition;
  visible: boolean;
}

/** Projected anchors never animate: the card inside owns its visible lifetime. */
export class MusicOverviewUI {
  private labels = new Map<number, LabelSurface>();
  private chrome: SurfaceTransition[];
  private active = false;
  private chromeShown = false;
  private revision = 0;
  private expandedLane: number | null = null;

  constructor(private surface: HTMLElement, private container: HTMLElement,
    private returnFocus: () => void) {
    this.chrome = Array.from(surface.querySelectorAll<HTMLElement>(
      ".overview-heading, .overview-controls, .overview-return",
    )).map((element) => {
      element.hidden = true;
      return new SurfaceTransition(element, element, 460, 240, "up",
        "cubic-bezier(0.4, 0, 0.2, 1)");
    });
  }

  setActive(active: boolean, reduced: boolean) {
    if (this.active === active && (active || this.surface.hidden)) return;
    const revision = ++this.revision;
    this.active = active;
    this.collapse();
    this.surface.inert = !active;
    this.surface.setAttribute("aria-hidden", String(!active));
    if (active) {
      this.surface.hidden = false;
      if (reduced) this.showChrome(true);
      return;
    }
    this.chromeShown = false;
    if (this.surface.contains(document.activeElement)) this.returnFocus();
    for (const [lane, label] of this.labels) this.hideLabel(lane, label, reduced);
    this.chrome.forEach((motion, index) => motion.hide(reduced, () => {
      if (index === this.chrome.length - 1 && revision === this.revision && !this.active)
        this.surface.hidden = true;
    }));
  }

  private showChrome(reduced: boolean) {
    if (this.chromeShown) return;
    this.chromeShown = true;
    this.chrome.forEach((motion) => motion.show(reduced));
    this.returnFocus();
  }

  expand(lane: number) {
    if (!this.active || !this.labels.get(lane)?.visible) return;
    this.expandedLane = lane;
    this.syncExpansion();
  }

  collapse() {
    this.expandedLane = null;
    this.syncExpansion();
  }

  canEnter(lane: number) {
    return this.active && this.expandedLane === lane && !!this.labels.get(lane)?.visible;
  }

  private syncExpansion() {
    for (const [lane, item] of this.labels) {
      const expanded = lane === this.expandedLane && item.visible;
      // Keep focus on the name if a navigation input folds its entry button.
      if (!expanded && document.activeElement === item.enter) item.label.focus({ preventScroll: true });
      item.card.dataset.expanded = String(expanded);
      item.label.setAttribute("aria-expanded", String(expanded));
      item.enter.disabled = !expanded;
      item.enter.tabIndex = expanded ? 0 : -1;
      item.enter.setAttribute("aria-hidden", String(!expanded));
    }
  }

  update(columns: OverviewColumn[], width: number, height: number, progress: number,
    reduced: boolean, columnName: string) {
    if (this.surface.hidden) return;
    if (this.active && progress > .12) this.showChrome(reduced);
    const ready = this.active && progress > .75;
    this.surface.dataset.ready = String(ready);
    const retained = new Set(Array.from(this.labels).filter(([, item]) => item.visible).map(([lane]) => lane));
    const visible = ready ? visibleOverviewLabels(columns, width, height, retained, this.expandedLane) : [];
    const wanted = new Set(visible.map((column) => column.lane));
    // Also project labels during their exit; fading never pins one in mid-air.
    for (const column of columns) {
      const item = this.labels.get(column.lane);
      if (item) this.place(item, column);
    }
    for (const [lane, item] of this.labels) if (!wanted.has(lane) && item.visible)
      this.hideLabel(lane, item, reduced);
    for (const column of visible) {
      let item = this.labels.get(column.lane);
      if (!item) {
        const anchor = document.createElement("div");
        anchor.className = "overview-anchor";
        anchor.innerHTML = '<div class="overview-column"><button type="button" class="overview-column-label"><strong></strong><small></small></button><span class="overview-enter-slot"><button type="button" class="overview-enter">进入 <span aria-hidden="true">→</span></button></span></div>';
        const card = anchor.querySelector<HTMLDivElement>(".overview-column")!;
        card.hidden = true;
        const label = anchor.querySelector<HTMLButtonElement>(".overview-column-label")!;
        const enter = anchor.querySelector<HTMLButtonElement>(".overview-enter")!;
        label.dataset.overviewLane = String(column.lane);
        enter.dataset.overviewEnterLane = String(column.lane);
        enter.id = `overview-enter-${column.lane}`;
        label.setAttribute("aria-controls", enter.id);
        item = { anchor, card, label, enter, visible: false,
          transition: new SurfaceTransition(card, card, 460, 240, "up",
            "cubic-bezier(0.4, 0, 0.2, 1)") };
        this.labels.set(column.lane, item);
        this.container.append(anchor);
      }
      this.place(item, column);
      item.label.title = column.name;
      item.label.setAttribute("aria-label", `展开${columnName}入口：${column.name}`);
      const name = item.label.querySelector("strong")!, count = item.label.querySelector("small")!;
      const caption = `${String(column.lane + 1).padStart(2, "0")} / ${column.count} 张专辑`;
      if (name.textContent !== column.name) name.textContent = column.name;
      if (count.textContent !== caption) count.textContent = caption;
      item.enter.setAttribute("aria-label", `进入${column.name}的标准视图`);
      item.card.setAttribute("aria-current", String(column.selected));
      item.label.disabled = !ready;
      if (!item.visible) {
        item.visible = true;
        item.anchor.inert = false;
        item.transition.show(reduced);
      }
    }
    this.syncExpansion();
  }

  private place(item: LabelSurface, column: OverviewColumn) {
    item.anchor.style.left = `${column.x.toFixed(2)}px`;
    item.anchor.style.top = `${column.y.toFixed(2)}px`;
    // Physical edge visibility and UI fades have separate owners. An outgoing
    // card stays attached and reaches zero opacity before its pool slot recycles.
    item.anchor.style.opacity = String(column.extent ?? 1);
  }

  private hideLabel(lane: number, item: LabelSurface, reduced: boolean) {
    item.visible = false;
    item.anchor.inert = true;
    if (this.expandedLane === lane) this.expandedLane = null;
    if (item.anchor.contains(document.activeElement)) this.returnFocus();
    item.transition.hide(reduced, () => {
      if (item.visible) return;
      item.transition.dispose();
      item.anchor.remove();
      this.labels.delete(lane);
    });
  }

  finish() {
    this.chrome.forEach((motion) => motion.finish());
    for (const item of this.labels.values()) item.transition.finish();
  }

  dispose() {
    this.revision++;
    this.chrome.forEach((motion) => motion.dispose());
    for (const item of this.labels.values()) item.transition.dispose();
    this.labels.clear();
  }
}
