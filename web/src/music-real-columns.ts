import type { ArchiveCell } from "./archive-loop.ts";
import { musicArchiveTravelDuration } from "./music-archive-motion.ts";
import { damp } from "./motion.ts";

type Polynomial = [number, number, number, number, number, number];
type ScalarOptions = { guided?: boolean; duration?: number; rate?: number };

/** One displayed coordinate; guided retargets preserve position, speed and acceleration. */
export class MusicRealColumnScalar {
  value: number;
  velocity = 0;
  acceleration = 0;
  target: number;
  private rate = 3.7;
  private polynomial?: Polynomial;
  private elapsed = 0;
  private duration = 0;

  constructor(value: number) { this.value = this.target = value; }

  get guided() { return this.polynomial !== undefined; }
  get settled() {
    return !this.guided && Math.abs(this.value - this.target) < .008 && Math.abs(this.velocity) < .025;
  }
  get state() {
    return { value: this.value, velocity: this.velocity, acceleration: this.acceleration,
      target: this.target, guided: this.guided, settled: this.settled };
  }

  retarget(target: number, { guided = false, duration = 1.4, rate = 3.7 }: ScalarOptions = {}) {
    // An unchanged destination must not restart a recovering column's clock.
    if (target === this.target) return;
    this.target = target;
    this.rate = rate;
    if (guided) {
      this.duration = Math.max(.001, duration);
      this.elapsed = 0;
      const t = this.duration, { value, velocity, acceleration } = this;
      const distance = target - value - velocity * t - acceleration * t * t / 2;
      const remainingVelocity = -velocity - acceleration * t;
      const remainingAcceleration = -acceleration;
      this.polynomial = [value, velocity, acceleration / 2,
        (10 * distance - 4 * remainingVelocity * t + remainingAcceleration * t * t / 2) / t ** 3,
        (-15 * distance + 7 * remainingVelocity * t - remainingAcceleration * t * t) / t ** 4,
        (6 * distance - 3 * remainingVelocity * t + remainingAcceleration * t * t / 2) / t ** 5];
    } else {
      this.polynomial = undefined;
      this.acceleration = rate * rate * (target - this.value) - 2 * rate * this.velocity;
    }
  }

  update(dt: number, reduced: boolean) {
    if (reduced) { this.finish(); return; }
    dt = Math.max(0, dt);
    if (this.polynomial) {
      this.elapsed = Math.min(this.duration, this.elapsed + dt);
      if (this.elapsed >= this.duration) { this.finish(); return; }
      const [a, b, c, d, e, f] = this.polynomial, t = this.elapsed;
      this.value = a + b * t + c * t ** 2 + d * t ** 3 + e * t ** 4 + f * t ** 5;
      this.velocity = b + 2 * c * t + 3 * d * t ** 2 + 4 * e * t ** 3 + 5 * f * t ** 4;
      this.acceleration = 2 * c + 6 * d * t + 12 * e * t ** 2 + 20 * f * t ** 3;
    } else {
      damp(this, this.target, this.rate, dt);
      this.acceleration = this.rate * this.rate * (this.target - this.value) - 2 * this.rate * this.velocity;
      if (Math.abs(this.value - this.target) < 1e-8 && Math.abs(this.velocity) < 1e-8) this.finish();
    }
  }

  private finish() {
    this.value = this.target;
    this.velocity = this.acceleration = 0;
    this.polynomial = undefined;
  }
}

type Column = { count: number; midpoint: number; row: MusicRealColumnScalar; activity: MusicRealColumnScalar };
export type MusicRealColumnSelectionOptions = { guided?: boolean; detail?: boolean };

/** Finite shelves scroll independently. The caller supplies already-scaled dt. */
export class MusicRealColumns {
  private columns: Column[] = [];
  private selected: ArchiveCell = { lane: -1, row: 12 };

  /** Optional rows seed a mode change from each column's actual displayed depth. */
  reset(counts: readonly number[], selected: ArchiveCell, rows?: readonly (number | undefined)[]) {
    this.columns = counts.map((raw, lane) => {
      const count = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
      const midpoint = 12 + Math.max(0, count - 1) / 2;
      const initial = Number.isFinite(rows?.[lane]) ? rows![lane]! :
        lane === selected.lane && count > 0 ? Math.max(12, Math.min(11 + count, selected.row)) : midpoint;
      return { count, midpoint, row: new MusicRealColumnScalar(initial), activity: new MusicRealColumnScalar(0) };
    });
    const first = this.columns.findIndex(column => column.count > 0);
    const lane = this.validLane(selected.lane) ? selected.lane : first;
    this.selected = { lane, row: lane < 0 ? 12 : this.clampRow(lane, selected.row) };
    const distance = Math.max(0, ...this.columns.map((column, i) =>
      Math.abs((i === lane ? this.selected.row : column.midpoint) - column.row.value)));
    const duration = musicArchiveTravelDuration(0, distance);
    for (const [i, column] of this.columns.entries()) {
      column.activity = new MusicRealColumnScalar(Number(i === lane));
      column.row.retarget(i === lane ? this.selected.row : column.midpoint, { guided: true, duration });
    }
  }

  select(cell: ArchiveCell, { guided = false, detail = false }: MusicRealColumnSelectionOptions = {}) {
    if (!this.validLane(cell.lane)) return;
    const row = this.clampRow(cell.lane, cell.row), previous = this.selected;
    if (previous.lane === cell.lane && previous.row === row) return;
    const changedLane = previous.lane !== cell.lane;
    const current = this.columns[cell.lane];
    const old = this.columns[previous.lane];
    const continueGuided = !detail && (guided || changedLane || current.row.guided);
    const distance = Math.max(Math.abs(row - current.row.value),
      changedLane && old ? Math.abs(old.midpoint - old.row.value) : 0);
    const duration = musicArchiveTravelDuration(changedLane ? cell.lane - previous.lane : 0, distance);
    const options = { guided: continueGuided, duration, rate: detail ? 9 : 3.7 };
    if (changedLane && old) {
      old.row.retarget(old.midpoint, options);
      old.activity.retarget(0, options);
    }
    current.row.retarget(row, options);
    current.activity.retarget(1, options);
    this.selected = { lane: cell.lane, row };
  }

  update(dt: number, reduced: boolean) {
    for (const column of this.columns) {
      column.row.update(dt, reduced);
      column.activity.update(dt, reduced);
    }
  }

  row(lane: number, overview = 0) {
    const column = this.columns[lane];
    if (!column) return 12;
    const progress = Math.max(0, Math.min(1, overview));
    return column.row.value + (column.midpoint - column.row.value) * progress;
  }

  activity(lane: number) { return Math.max(0, Math.min(1, this.columns[lane]?.activity.value ?? 0)); }
  settled(lane: number) {
    const column = this.columns[lane];
    return !column || (column.row.settled && column.activity.settled);
  }
  get state() {
    return this.columns.map((column, lane) => ({ lane, midpoint: column.midpoint,
      row: column.row.state, activity: column.activity.state }));
  }

  private validLane(lane: number) { return Number.isInteger(lane) && (this.columns[lane]?.count ?? 0) > 0; }
  private clampRow(lane: number, row: number) {
    return Math.max(12, Math.min(11 + this.columns[lane].count,
      Number.isFinite(row) ? row : this.columns[lane].midpoint));
  }
}
