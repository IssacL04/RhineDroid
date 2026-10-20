import * as THREE from "three";
import { damp } from "./motion.ts";

/** A shared transition drives camera framing and real-column centering. */
export class MusicOverviewMotion {
  private progress = { value: 0, velocity: 0 };
  active = false;
  get value() { return THREE.MathUtils.clamp(this.progress.value, 0, 1); }
  update(dt: number, reduced: boolean) {
    if (reduced) this.progress = { value: Number(this.active), velocity: 0 };
    else damp(this.progress, Number(this.active), 6.5, Math.max(0, dt));
    return this.value;
  }
  reset() { this.active = false; this.progress = { value: 0, velocity: 0 }; }
}

export function overviewFraming(width: number, height: number) {
  const aspect = Math.max(1, width) / Math.max(1, height);
  // Show about five columns in landscape and three on narrow portrait screens.
  return { span: Math.max(16.8, 17.5 / aspect), distance: 172, yaw: 28, elevation: 43 };
}

export interface OverviewColumn {
  lane: number;
  name: string;
  count: number;
  x: number;
  y: number;
  selected: boolean;
  /** Shared physical edge visibility; omitted by static projection fixtures. */
  extent?: number;
}

/** Cull labels near screen edges and collisions, prioritising the selected lane. */
export function visibleOverviewLabels(columns: OverviewColumn[], width: number, height: number,
  retained: ReadonlySet<number> = new Set(), expandedLane: number | null = null) {
  const labelWidth = width < 600 ? 116 : 160;
  const accepted: OverviewColumn[] = [];
  for (const column of [...columns].sort((a, b) => Number(b.lane === expandedLane) - Number(a.lane === expandedLane) ||
    Number(b.selected) - Number(a.selected) ||
    Math.abs(a.x - width / 2) - Math.abs(b.x - width / 2))) {
    if ((column.extent ?? 1) <= (retained.has(column.lane) ? .06 : .12)) continue;
    // A small exit buffer prevents a projected label from chattering at the
    // same edge where it entered. Its retained node still follows the column.
    const edge = retained.has(column.lane) ? -18 : 14;
    // Every candidate reserves its future right-hand entry button. Opening it
    // never shifts the artist name or suddenly culls the card that was clicked.
    const rightEdge = retained.has(column.lane) ? 14 : 34;
    if (column.x < labelWidth / 2 + edge || column.x > width - labelWidth / 2 - 76 - rightEdge ||
      column.y < 115 - (retained.has(column.lane) ? 20 : 0) ||
      column.y > height - 112 + (retained.has(column.lane) ? 20 : 0)) continue;
    const left = column.x - labelWidth / 2, right = column.x + labelWidth / 2 +
      (column.lane === expandedLane ? 76 : 0);
    if (accepted.some((other) => left < other.x + labelWidth / 2 +
      (other.lane === expandedLane ? 76 : 0) + 10 && right + 10 > other.x - labelWidth / 2 &&
      Math.abs(other.y - column.y) < 62)) continue;
    accepted.push(column);
  }
  return accepted.sort((a, b) => a.x - b.x);
}
