import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';

// Load production modules without copying their equations or depending on a
// particular Node release's support for TypeScript parameter properties.
function sourceModule(path, overrides = {}) {
  const url = new URL(path, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const code = outputText.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) =>
    `from ${JSON.stringify(overrides[specifier] ?? (specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier)))}`);
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
}

const motionModule = sourceModule('../src/motion.ts');
const { damp } = await import(motionModule);
const { MusicPlacementMotion } = await import(sourceModule('../src/music-camera.ts', {
  './motion.ts': motionModule,
  './viewport-layout.ts': sourceModule('../src/viewport-layout.ts'),
}));
const { followRowLight } = await import(sourceModule('../src/music-row-lighting.ts'));
const { ThemeTransition } = await import(sourceModule('../src/theme-transition.ts'));
const {
  normalizeMusicMotionSpeed, getMusicMotionSpeed, setMusicMotionSpeed,
  musicMotionDuration, onMusicMotionSpeedChange,
} = await import(sourceModule('../src/music-motion-settings.ts'));

const close = (actual, expected, tolerance, message) => assert.ok(
  Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
  `${message}: expected ${expected} ± ${tolerance}, received ${actual}`,
);

for (const value of [undefined, null, false, true, '', '2', {}, [], NaN, Infinity, -Infinity]) {
  assert.equal(normalizeMusicMotionSpeed(value), 1, 'Invalid stored values recover to normal speed');
}
for (const [value, expected] of [[-1, 0.25], [0, 0.25], [0.1, 0.25], [0.25, 0.25], [1, 1], [1.65, 1.65], [3, 3], [100, 3]]) {
  assert.equal(normalizeMusicMotionSpeed(value), expected, 'Finite stored values retain valid speeds or clamp to the supported range');
}
const notifications = [];
const unsubscribe = onMusicMotionSpeedChange((speed) => notifications.push(speed));
setMusicMotionSpeed(1);
setMusicMotionSpeed(0.25);
setMusicMotionSpeed(0.25);
setMusicMotionSpeed(3);
unsubscribe();
setMusicMotionSpeed(NaN);
assert.deepEqual(notifications, [0.25, 3], 'Only changed normalized speeds notify active listeners');
assert.equal(getMusicMotionSpeed(), 1, 'Invalid live values also restore normal speed');

function measure(speed, fps, lightDuration = 1.1) {
  setMusicMotionSpeed(speed);
  close(musicMotionDuration(460), 460 / speed, 1e-9, 'DOM durations use the same multiplier');
  const dt = Math.min(1 / fps, 0.05) * getMusicMotionSpeed();
  const placement = new MusicPlacementMotion();
  const rail = { value: 0, velocity: 0 };
  const light = { value: 0, velocity: 0 };
  const times = {};
  // Eighteen virtual seconds also verify the spring tail reaches its endpoint.
  const frames = Math.ceil(18 * fps / speed);
  for (let frame = 1; frame <= frames; frame++) {
    const previous = [placement.value, rail.value, light.value];
    placement.update(1, dt, false);
    damp(rail, 1, 3.7, dt);
    followRowLight(light, 1, dt, lightDuration);
    [placement.value, rail.value, light.value].forEach((value, index) => {
      assert.ok(Number.isFinite(value) && value >= previous[index] - 1e-10 && value <= 1 + 1e-10,
        `Forward motion stays finite and bounded at ${speed}× / ${fps} fps`);
    });
    const realTime = frame / fps;
    if (placement.settled && times.placement === undefined) times.placement = realTime;
    if (rail.value >= 0.95 && times.rail === undefined) times.rail = realTime;
    if (light.value >= 0.95 && times.light === undefined) times.light = realTime;
  }
  assert.equal(placement.value, 1, 'Placement reaches the exact detail endpoint');
  assert.equal(placement.velocity, 0, 'Placement finishes at rest');
  close(rail.value, 1, 1e-9, 'Rail settles at the same endpoint at every speed');
  close(light.value, 1, 1e-9, 'Light settles at the same endpoint at every speed');
  close(rail.velocity, 0, 1e-9, 'Rail settles at rest');
  close(light.velocity, 0, 1e-9, 'Light settles at rest');
  for (let frame = 0; frame < frames; frame++) {
    placement.update(0, dt, false);
    damp(rail, 0, 3.7, dt);
    followRowLight(light, 0, dt, lightDuration);
  }
  assert.equal(placement.value, 0, 'Return reaches the exact archive endpoint');
  close(rail.value, 0, 1e-9, 'Rail return reaches the original location');
  close(light.value, 0, 1e-9, 'Light return reaches the original location');
  return times;
}

for (const fps of [20, 30, 60, 120]) {
  const baseline = measure(1, fps);
  for (const speed of [0.25, 1, 3]) {
    const actual = measure(speed, fps);
    for (const key of ['placement', 'rail', 'light']) {
      // Each threshold is sampled on frames, so both the baseline and scaled
      // measurement can contribute at most one frame of timing uncertainty.
      close(actual[key], baseline[key] / speed, (1 + 1 / speed) / fps + 1e-9,
        `${key} duration scales at ${speed}× / ${fps} fps, including 3× low-fps frames`);
    }
    close(actual.light, 1.1 / speed, 1 / fps + 1e-9,
      'The displayed light duration means 95% travel divided by the global speed');
  }
}

// Independent light settings compose with the global speed once. Evaluate at
// the advertised real duration; all combinations must reach the same 95% mark.
for (const duration of [0.4, 1.1, 2.4]) for (const speed of [0.25, 1, 3]) {
  setMusicMotionSpeed(speed);
  const state = { value: 0, velocity: 0 };
  const realDuration = musicMotionDuration(duration);
  const frames = Math.ceil(realDuration * 120);
  for (let frame = 0; frame < frames; frame++) {
    followRowLight(state, 1, realDuration / frames * getMusicMotionSpeed(), duration);
  }
  close(state.value, 0.95, 1e-9, `Light ${duration}s and ${speed}× combine without double scaling`);
  assert.ok(state.velocity > 0, 'The 95% mark retains the light tail rather than snapping');
  const reduced = new MusicPlacementMotion();
  reduced.update(1, 1 / 60 * getMusicMotionSpeed(), true);
  assert.equal(reduced.value, 1, 'Reduced motion remains immediate at every saved speed');
  assert.equal(reduced.settled, true, 'Reduced motion does not wait for a slowed timeline');
}

const realPerformance = globalThis.performance;
try {
  globalThis.performance = { now: () => 100_000 };
  for (const speeds of [[0.25, 3], [3, 0.25], [1, 0.25, 3, 1]]) {
    const value = { amount: 0 };
    const color = new THREE.Color(0, 0, 0);
    const targetColor = new THREE.Color(1, 0.5, 0.25);
    const theme = new ThemeTransition();
    theme.number(value, 'amount', 1);
    theme.color(color, targetColor);
    let now = 100;
    let previous = 0;
    for (const speed of speeds) {
      theme.update(now, speed);
      close(value.amount, previous, 1e-9, 'Editing speed at the same timestamp cannot jump theme progress');
      for (let frame = 0; frame < 5; frame++) {
        now += 1 / 120;
        theme.update(now, speed);
        assert.ok(value.amount >= previous - 1e-10 && value.amount <= 1,
          'Changing theme speed mid-flight never rewinds or overshoots');
        previous = value.amount;
      }
    }
    assert.ok(previous > 0 && previous < 1, 'Speed changes occur while the theme is actually moving');
    assert.equal(theme.update(now + 4, speeds.at(-1)), true, 'Retimed theme still reports completion');
    assert.equal(value.amount, 1, 'Retimed theme finishes on the exact numeric target');
    assert.deepEqual(color.toArray(), targetColor.toArray(), 'Retimed theme finishes on the exact palette');
  }
} finally {
  globalThis.performance = realPerformance;
  setMusicMotionSpeed(1);
}

console.log('Music motion speed passed: invalid settings, live notifications, 0.25/1/3× endpoints and proportional timing at 20/30/60/120 fps, independent light-duration composition, reduced motion and continuous mid-flight theme retiming.');
