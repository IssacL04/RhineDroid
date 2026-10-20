import assert from 'node:assert/strict';
import { MusicRealColumns, MusicRealColumnScalar } from '../src/music-real-columns.ts';
import { musicArchiveTravelDuration } from '../src/music-archive-motion.ts';
import { damp } from '../src/motion.ts';

const close = (actual, expected, tolerance = 1e-8) => assert.ok(
  Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
  `${actual} differs from ${expected} by more than ${tolerance}`);
const derivatives = scalar => [scalar.value, scalar.velocity, scalar.acceleration];
const midpoint = count => 12 + (count - 1) / 2;
const counts = [100, 49, 3, 2, 1];
const advance = (motion, seconds, fps = 60, speed = 1) => {
  const frames = Math.floor(seconds * fps / speed);
  for (let i = 0; i < frames; i++) motion.update(speed / fps, false);
  const remainder = seconds - frames * speed / fps;
  if (remainder > 1e-12) motion.update(remainder, false);
};

// A finite shelf starts with its selected album aligned, and every other whole
// column centered. Half rows are deliberate for columns containing even counts.
{
  const motion = new MusicRealColumns();
  motion.reset(counts, { lane: 0, row: 12 });
  assert.deepEqual(counts.map((_, lane) => motion.row(lane)), [12, 36, 13, 12.5, 12]);
  assert.deepEqual(counts.map((_, lane) => motion.activity(lane)), [1, 0, 0, 0, 0]);
  assert.ok(counts.every((_, lane) => motion.settled(lane)));
  for (let lane = 0; lane < counts.length; lane++) {
    close(motion.row(lane, 1), midpoint(counts[lane]));
    close(motion.row(lane, .5), (motion.row(lane) + midpoint(counts[lane])) / 2);
  }
  const before = motion.state;
  motion.select({ lane: 0, row: 12 }, { guided: true });
  assert.deepEqual(motion.state, before, 'Selecting the same cell does not restart animation');
}

// Cross-column travel starts at that column's displayed midpoint, not at the
// last column's selected row. Its return and entry use one measured duration.
for (const fps of [20, 30, 60, 120]) for (const speed of [.25, 1, 3]) {
  const motion = new MusicRealColumns();
  motion.reset(counts, { lane: 0, row: 12 });
  const initial = motion.state;
  motion.select({ lane: 1, row: 60 });
  for (const lane of [0, 1])
    assert.deepEqual(derivatives(motion.state[lane].row), derivatives(initial[lane].row),
      'Changing columns is continuous at the request frame');
  assert.equal(motion.state[0].row.guided, true);
  assert.equal(motion.state[1].row.guided, true);
  const duration = musicArchiveTravelDuration(1, midpoint(counts[0]) - 12);
  let elapsed = 0, previous = 0;
  while (!motion.settled(0) || !motion.settled(1)) {
    motion.update(speed / fps, false);
    elapsed += 1 / fps;
    const progress = (motion.row(1) - 36) / 24;
    assert.ok(progress >= previous - 1e-9 && progress <= 1 + 1e-9,
      'Rest-to-rest column travel stays monotone');
    close((motion.row(0) - 12) / (midpoint(counts[0]) - 12), progress);
    close(motion.activity(1), progress);
    close(motion.activity(0), 1 - progress);
    for (let lane = 2; lane < counts.length; lane++) {
      assert.deepEqual(motion.state[lane], initial[lane], 'Uninvolved columns remain unchanged');
      close(motion.row(lane), midpoint(counts[lane]));
    }
    previous = progress;
    assert.ok(elapsed < 11, 'Slow travel finishes in a finite time');
  }
  close(elapsed, duration / speed, 1 / fps + 1e-9);
  close(motion.row(0), midpoint(counts[0]));
  close(motion.row(1), 60);
  assert.equal(motion.activity(0), 0);
  assert.equal(motion.activity(1), 1);
}

// Normal row browsing and detail switches keep the established spring cadence.
for (const rate of [3.7, 9]) for (const fps of [20, 30, 60, 120]) {
  const motion = new MusicRealColumns(), spring = { value: 40, velocity: 0 };
  motion.reset(counts, { lane: 0, row: 40 });
  const untouched = motion.state.slice(1);
  motion.select({ lane: 0, row: 41 }, { detail: rate === 9 });
  assert.equal(motion.state[0].row.guided, false);
  for (let i = 0; i < fps; i++) {
    damp(spring, 41, rate, 1 / fps);
    motion.update(1 / fps, false);
    close(motion.row(0), spring.value);
    close(motion.state[0].row.velocity, spring.velocity);
    assert.deepEqual(motion.state.slice(1), untouched);
  }
  const before = derivatives(motion.state[0].row);
  motion.select({ lane: 0, row: 39 }, { detail: rate === 9 });
  assert.deepEqual(derivatives(motion.state[0].row).slice(0, 2), before.slice(0, 2),
    'Reversing ordinary browsing preserves displayed position and velocity');
}

// Programmatic requests and a second key during them inherit all derivatives,
// even when the first motion came from an ordinary spring.
for (const time of [.12, .7, 1.2]) {
  const motion = new MusicRealColumns();
  motion.reset(counts, { lane: 0, row: 15 });
  motion.select({ lane: 0, row: 16 });
  advance(motion, .2);
  let before = derivatives(motion.state[0].row);
  motion.select({ lane: 0, row: 100 }, { guided: true });
  assert.deepEqual(derivatives(motion.state[0].row), before, 'Spring-to-guided handoff preserves acceleration');
  advance(motion, time);
  before = derivatives(motion.state[0].row);
  motion.select({ lane: 0, row: 14 });
  assert.deepEqual(derivatives(motion.state[0].row), before, 'A key during guided travel continues the trajectory');
  assert.equal(motion.state[0].row.guided, true);
  motion.update(0, false);
  assert.deepEqual(derivatives(motion.state[0].row), before);
  motion.update(1e-6, false);
  for (let i = 0; i < 3; i++) close(derivatives(motion.state[0].row)[i], before[i], i === 2 ? .01 : .001);
  advance(motion, 3);
  assert.equal(motion.row(0), 14);
  assert.equal(motion.state[0].row.acceleration, 0);
}

// Switching back while both columns are moving keeps each column's own live
// derivatives. A third column's input must not restart another return clock.
for (const time of [.12, .7, 1.2]) {
  const motion = new MusicRealColumns();
  motion.reset(counts, { lane: 0, row: 12 });
  motion.select({ lane: 1, row: 60 });
  advance(motion, time);
  const before = motion.state;
  motion.select({ lane: 0, row: 100 });
  for (const lane of [0, 1]) for (const key of ['row', 'activity'])
    assert.deepEqual(derivatives(motion.state[lane][key]), derivatives(before[lane][key]));
  advance(motion, 3);
  close(motion.row(0), 100);
  close(motion.row(1), midpoint(counts[1]));
  assert.equal(motion.activity(0), 1);
  assert.equal(motion.activity(1), 0);
}
{
  const motion = new MusicRealColumns(), control = new MusicRealColumns();
  for (const instance of [motion, control]) {
    instance.reset(counts, { lane: 0, row: 12 });
    instance.select({ lane: 1, row: 60 });
    advance(instance, .3);
  }
  motion.select({ lane: 2, row: 14 });
  for (let frame = 0; frame < 180; frame++) {
    motion.update(1 / 60, false);
    control.update(1 / 60, false);
    assert.deepEqual(motion.state[0], control.state[0], 'Other selections do not perturb an inactive column returning home');
    for (let lane = 0; lane < counts.length; lane++)
      assert.ok(motion.activity(lane) >= 0 && motion.activity(lane) <= 1);
  }
}

// A mode change seeds the exact rendered depths first, then restores independent
// targets. Overview is a projection of the same state, never a second animation.
{
  const motion = new MusicRealColumns();
  const rows = [23.75, 23.75, 23.75, 23.75, 23.75];
  motion.reset(counts, { lane: 0, row: 40 }, rows);
  assert.deepEqual(counts.map((_, lane) => motion.row(lane)), rows);
  const before = motion.state;
  for (const progress of [0, .2, .7, 1, .4, 0]) {
    for (let lane = 0; lane < counts.length; lane++)
      close(motion.row(lane, progress), rows[lane] + (midpoint(counts[lane]) - rows[lane]) * progress);
    assert.deepEqual(motion.state, before, 'Overview queries never mutate column motion');
  }
  advance(motion, 3);
  assert.deepEqual(counts.map((_, lane) => motion.row(lane)), [40, 36, 13, 12.5, 12]);
  motion.reset([3, 1], { lane: 1, row: 12 });
  assert.equal(motion.state.length, 2, 'A library refresh drops prior column state');
  assert.deepEqual(motion.state.map(column => column.row.value), [13, 12]);
}

// The caller scales dt once. Equal logical time must give identical results,
// and reduced motion snaps row and activation together even on a zero-dt frame.
for (const fps of [20, 30, 60, 120]) for (const speed of [.25, 1, 3]) {
  const motion = new MusicRealColumns(), reference = new MusicRealColumns();
  for (const instance of [motion, reference]) {
    instance.reset(counts, { lane: 0, row: 12 });
    instance.select({ lane: 1, row: 60 });
  }
  advance(motion, .8, fps, speed);
  reference.update(.8, false);
  for (const lane of [0, 1]) for (const key of ['row', 'activity'])
    for (let i = 0; i < 3; i++) close(derivatives(motion.state[lane][key])[i], derivatives(reference.state[lane][key])[i]);
  motion.update(0, true);
  for (const state of motion.state) for (const key of ['row', 'activity']) {
    assert.equal(state[key].value, state[key].target);
    assert.equal(state[key].velocity, 0);
    assert.equal(state[key].acceleration, 0);
    assert.equal(motion.settled(state.lane), true);
  }
  motion.select({ lane: 1, row: 59 });
  assert.equal(motion.state[1].row.guided, false, 'Reduced completion releases guided ownership');
  motion.update(0, true);
  assert.equal(motion.row(1), 59);
}

// A standalone scalar gives a direct physical check of the eased start and
// exact derivative preservation, independent of the column coordinator.
{
  const scalar = new MusicRealColumnScalar(0);
  scalar.retarget(1, { guided: true });
  scalar.update(.2, false);
  assert.ok(scalar.value < .025, 'First 200 ms uses the existing gentle archive cadence');
  const before = derivatives(scalar.state);
  scalar.retarget(-1, { guided: true });
  assert.deepEqual(derivatives(scalar.state), before);
  scalar.update(2, false);
  assert.deepEqual(derivatives(scalar.state), [-1, 0, 0]);
}

{
  const motion = new MusicRealColumns();
  motion.reset([], { lane: 0, row: 12 });
  motion.select({ lane: 0, row: 13 });
  motion.update(0, true);
  assert.deepEqual(motion.state, []);
  assert.equal(motion.activity(-1), 0);
  assert.equal(motion.settled(-1), true);
  motion.reset([0, 1, 2], { lane: 1, row: 12 });
  const before = motion.state;
  for (const lane of [-1, 0, .5, 3]) motion.select({ lane, row: 12 });
  assert.deepEqual(motion.state, before, 'Empty and nonexistent columns never receive selection');
  motion.select({ lane: 2, row: 999 });
  motion.update(0, true);
  assert.equal(motion.row(2), 13, 'Finite columns clamp requested rows to their actual range');
}

console.log('Real music columns: independent centering, spring/guided retargets, overview, mode seeding, speed and reduced-motion checks passed.');
