// Exercise the production metrics class without a renderer or DOM.
import assert from 'node:assert/strict';
import { MusicFrameTiming } from '../src/music-frame-timing.ts';

const empty = { samples: 0, fps: 0, frameP50: 0, frameP95: 0, frameMax: 0, over50ms: 0, cpuP95: 0 };
const timing = new MusicFrameTiming();
assert.deepEqual(timing.snapshot(), empty, 'An unstarted counter has no loading-time samples');
timing.begin(30000);
timing.end(2);
assert.deepEqual(timing.snapshot(), { ...empty, cpuP95: 2 }, 'The first visible frame does not turn a 30 s load into a frame gap');
for (let index = 1; index <= 600; index++) {
  timing.begin(30000 + index * 1000 / 60);
  timing.end(3);
}
assert.deepEqual(timing.snapshot(), {
  samples: 240, fps: 60, frameP50: 16.67, frameP95: 16.67, frameMax: 16.67, over50ms: 0, cpuP95: 3,
}, 'Steady 60 Hz statistics retain only the latest 240 gaps');

const uneven = new MusicFrameTiming();
uneven.begin(1000);
uneven.end(1);
let now = 1000;
for (const [gap, cpu] of [[10, 2], [20, 3], [30, 4], [40, 8], [60, -1]]) {
  now += gap;
  uneven.begin(now);
  uneven.end(cpu);
}
assert.deepEqual(uneven.snapshot(), {
  samples: 5, fps: 31.3, frameP50: 30, frameP95: 60, frameMax: 60, over50ms: 1, cpuP95: 8,
}, 'FPS is elapsed-gap weighted; frame and CPU percentiles have separate units');
const snapshot = uneven.snapshot();
snapshot.frameP95 = -99;
assert.equal(uneven.snapshot().frameP95, 60, 'Consumers cannot mutate the metric window through a snapshot');

const rolling = new MusicFrameTiming();
rolling.begin(0);
rolling.end(900);
rolling.begin(500);
rolling.end(900);
assert.equal(rolling.snapshot().over50ms, 1);
for (let index = 1; index <= 240; index++) {
  rolling.begin(500 + index * 1000 / 120);
  rolling.end(1.5);
}
assert.deepEqual(rolling.snapshot(), {
  samples: 240, fps: 120, frameP50: 8.33, frameP95: 8.33, frameMax: 8.33, over50ms: 0, cpuP95: 1.5,
}, 'An expired slow startup frame cannot permanently depress the displayed frame rate');

timing.reset();
assert.deepEqual(timing.snapshot(), empty, 'Hiding/disposal clears all frame and CPU samples');
timing.begin(900000);
timing.end(4);
timing.begin(900020);
timing.end(5);
assert.deepEqual(timing.snapshot(), {
  samples: 1, fps: 50, frameP50: 20, frameP95: 20, frameMax: 20, over50ms: 0, cpuP95: 5,
}, 'A long hidden interval is excluded after reset');

const bounded = new MusicFrameTiming();
bounded.begin(100);
bounded.end(-8);
bounded.begin(90);
bounded.end(-2);
assert.deepEqual(bounded.snapshot(), { ...empty, samples: 1 }, 'Clock corrections and negative elapsed inputs do not create negative metrics');
console.log('Music frame timing: cold start, 600-frame steady window, percentiles, eviction, reset and nonnegative input checks passed.');
