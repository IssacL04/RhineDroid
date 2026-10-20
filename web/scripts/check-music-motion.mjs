import assert from 'node:assert/strict';
import { musicSelectionWave, baselineSelectionWave, damp } from '../src/motion.ts';

// Exercise the combined taller music lift and wave: the previous superposition
// produced a sharp early peak followed by a dip before the lift had settled.
function sample(rate, wave) {
  const lift = { value: 0, velocity: 0 };
  const values = [0];
  for (let frame = 1; frame <= rate * 3; frame++) {
    damp(lift, 0.9, 4.2, 1 / rate);
    values.push(lift.value + wave(0, frame / rate));
  }
  return values;
}
const current = sample(60, musicSelectionWave);
const previous = sample(60, baselineSelectionWave);
assert.ok(current[6] < previous[6] * 0.3, 'First 100 ms should not jump with the archive crest');
assert.ok(current[12] < 0.3, 'First 200 ms remains a gentle departure');
for (let frame = 1; frame < current.length; frame++) {
  assert.ok(current[frame] >= current[frame - 1] - 1e-6, 'Isolated selected CD rises without an early bounce/dip');
  assert.ok(current[frame] - current[frame - 1] < 0.035, 'Limit the per-frame change at 60 Hz');
}
assert.ok(Math.abs(current.at(-1) - 0.9) < 0.001, 'Final cover exposure height is preserved');
const slow = sample(30, musicSelectionWave), fast = sample(120, musicSelectionWave);
for (let frame = 0; frame < slow.length; frame++)
  assert.ok(Math.abs(slow[frame] - fast[frame * 4]) < 1e-9, 'Equal elapsed time gives equal motion');
let hasTrough = false, hasNeighborCrest = false;
for (let frame = 0; frame <= 192; frame++) for (let distance = 0; distance <= 16; distance += 0.25) {
  const value = musicSelectionWave(distance, frame / 60);
  assert.ok(Number.isFinite(value) && Math.abs(value) < 0.2);
  hasTrough ||= value < -0.025;
  hasNeighborCrest ||= distance > 2 && value > 0.1;
}
assert.ok(hasTrough && hasNeighborCrest, 'Keep a small outward crest and signed settling wave');
console.log('Music motion passed: gentle first 200 ms, no early dip, unchanged final height, 30/120 Hz equivalence, small neighboring wave.');
