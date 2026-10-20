import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';

function sourceModule(path, overrides = {}) {
  const url = new URL(path, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const code = outputText.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) =>
    `from ${JSON.stringify(overrides[specifier] ?? (specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier)))}`);
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
}

const rowModule = sourceModule('../src/music-row-lighting.ts');
const { ROW_LIGHTING, DEFAULT_ROW_LIGHTING, introRowOffset, followRowLight } = await import(rowModule);
const { damp } = await import(sourceModule('../src/motion.ts'));
const { MusicSelectionLighting } = await import(sourceModule('../src/music-lighting.ts', {
  './theme-transition.ts': sourceModule('../src/theme-transition.ts'),
  './music-row-lighting.ts': rowModule,
}));
const { MusicRealColumns } = await import(sourceModule('../src/music-real-columns.ts'));

const EPSILON = 1e-9;
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < EPSILON,
  `${message}: expected ${expected}, received ${actual}`);
function bounded(value, previous, target, message) {
  assert.ok(Number.isFinite(value) && value >= Math.min(previous, target) - EPSILON &&
    value <= Math.max(previous, target) + EPSILON,
  `${message}: ${previous} -> ${value}, target ${target}`);
}

// The contract is immediate reversal with continuous position and no overshoot,
// including when a frame spans more than one usual display interval.
for (const [from, to] of [[0, 1], [6, -4], [-3, 5], [3, 3]]) {
  for (const dt of [0, 1 / 120, 1 / 60, 1 / 30, 0.25, 2]) {
    const next = followRowLight({ value: from, velocity: 0 }, to, dt, 1.2);
    bounded(next, from, to, 'Logical row following is bounded');
    if (dt > 0 && from !== to) assert.ok(Math.abs(next - to) < Math.abs(from - to),
      'A reversed target begins approaching immediately');
  }
  const split = { value: from, velocity: 0 };
  for (let i = 0; i < 12; i++) followRowLight(split, to, 1 / 120, 1.2);
  close(split.value, followRowLight({ value: from, velocity: 0 }, to, 0.1, 1.2),
    'Logical following is independent of frame subdivision');
}

// The control has a measurable duration rather than an arbitrary spring rate.
// A fresh move eases in, stays near the camera/rail's 3.7-rate choreography, and
// reaches 95% at the displayed duration on all common display refresh rates.
for (const duration of [0.4, 1.2, 2.4]) for (const fps of [30, 60, 120]) {
  const state = { value: 0, velocity: 0 };
  for (let i = 0; i < Math.round(duration * fps); i++) followRowLight(state, 1, 1 / fps, duration);
  close(state.value, 0.95, `${duration}s control reaches 95% at ${fps} fps`);
  assert.ok(state.velocity > 0, 'The tail eases out instead of abruptly stopping at 95%');
}
const firstFrame = followRowLight({ value: 0, velocity: 0 }, 1, 1 / 60, DEFAULT_ROW_LIGHTING.transitionDuration);
assert.ok(firstFrame > 0 && firstFrame < 0.003, 'The first keyboard/mouse frame starts softly');
for (const time of [0.1, 0.3, 0.6, 1.2]) {
  const rail = { value: 0, velocity: 0 };
  damp(rail, 1, 3.7, time);
  const light = followRowLight({ value: 0, velocity: 0 }, 1, time, DEFAULT_ROW_LIGHTING.transitionDuration);
  assert.ok(Math.abs(light - rail.value) < 0.04, 'Default light progress matches the shelf rail throughout the move');
}
const continuing = { value: 0, velocity: 0 };
followRowLight(continuing, 1, 0.2, 1.2);
const continuingStart = continuing.value;
const fresh = { value: continuingStart, velocity: 0 };
followRowLight(continuing, 2, 1 / 60, 1.2);
followRowLight(fresh, 2, 1 / 60, 1.2);
assert.ok(continuing.value > fresh.value, 'Repeated forward input preserves helpful velocity');
const reversalStart = continuing.value;
followRowLight(continuing, -1, 1 / 60, 1.2);
assert.ok(continuing.value < reversalStart && continuing.velocity < 0, 'Reversal turns on the very next frame');
const fast = { value: 0, velocity: 40 };
followRowLight(fast, 0.01, 1 / 60, 2.4);
assert.ok(fast.value > 0 && fast.value < 0.01 && fast.velocity > 0,
  'An unexpectedly near target brakes before it rather than hitting a hard endpoint clamp');

function setup(row = 12, lane = 2) {
  const scene = new THREE.Scene();
  const model = new THREE.Group();
  scene.add(model);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(-62, 36, 43); camera.lookAt(0, 0, 0);
  const light = new MusicSelectionLighting(scene);
  light.setExperiment({ mode: 'guided' });
  const shell = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  const print = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  light.shade(shell, 'Frosted_Polymer'); light.shadePrint(print);
  assert.ok(shell.uniforms.musicRowColumn, 'Shell exposes the dedicated narrow-row field anchor');
  assert.equal(print.uniforms.musicRowColumn, shell.uniforms.musicRowColumn,
    'Print and shell receive exactly the same moving row field');
  assert.notEqual(shell.uniforms.musicRowColumn, shell.uniforms.musicLightColumn,
    'The narrow row anchor is independent of the original broad selection key');
  const state = {
    scene, model, camera, light, shell, print,
    target: { row, lane }, origin: { row: 0, lane: 0 },
    rail: { value: -2.17 - (row - 15.5) * ROW_LIGHTING.rowSpacing, velocity: 0 },
    column: { value: (lane - 2) * ROW_LIGHTING.laneSpacing, velocity: 0 },
  };
  place(state);
  update(state, 0, true);
  return state;
}

function place(state, entryZ = 0) {
  const { model, target, origin, rail, column } = state;
  model.position.set(
    (target.lane - origin.lane - 2) * ROW_LIGHTING.laneSpacing - column.value,
    -4.6,
    (target.row - origin.row - 15.5) * ROW_LIGHTING.rowSpacing + entryZ + rail.value,
  );
}

function update(state, dt, reduced = false, introTime) {
  state.light.update(state.model, state.camera, dt, true, reduced, introTime !== undefined, 0,
    { ...state.target, independentColumns: state.independentColumns,
      ...(introTime === undefined ? {} : { introTime }) });
}

function logicalLight(state) {
  const column = state.shell.uniforms.musicRowColumn.value;
  const world = state.model.getWorldPosition(new THREE.Vector3());
  return {
    row: state.target.row + (column.z - world.z) / ROW_LIGHTING.rowSpacing,
    lane: state.target.lane + (column.x - world.x) / ROW_LIGHTING.laneSpacing,
  };
}

function advance(state, dt, entryZ = 0) {
  // These are the production archive's rates and target coordinates. Testing
  // only a stationary world-space model missed the original double-spring bug.
  damp(state.rail, -2.17 - (state.target.row - state.origin.row - 15.5) * ROW_LIGHTING.rowSpacing, 3.7, dt);
  damp(state.column, (state.target.lane - state.origin.lane - 2) * ROW_LIGHTING.laneSpacing, 3.7, dt);
  place(state, entryZ);
  update(state, dt);
}

const scenarios = [
  { name: 'forward burst and hold', events: [[0, 13, 2], [0.1, 14, 2], [0.2, 15, 2]] },
  { name: 'forward/backward reversal', events: [[0, 13, 2], [0.1, 14, 2], [0.2, 15, 2], [0.3, 14, 2], [0.4, 13, 2], [0.5, 12, 2]] },
  { name: 'large alternating row and lane targets', events: [[0, 20, 5], [0.2, 8, -2], [0.4, 17, 4], [0.6, 12, 2]] },
];
for (const fps of [30, 60, 120]) for (const scenario of scenarios) {
  const state = setup();
  let previous = logicalLight(state);
  let event = 0;
  for (let frame = 0; frame < fps * 8; frame++) {
    const time = frame / fps;
    while (event < scenario.events.length && scenario.events[event][0] <= time + EPSILON) {
      const [, row, lane] = scenario.events[event++];
      state.target = { row, lane };
    }
    // A shared entry translation must not become extra logical light motion.
    advance(state, 1 / fps, 0.8 * Math.sin(time * 2.3));
    const actual = logicalLight(state);
    for (const axis of ['row', 'lane']) {
      bounded(actual[axis], previous[axis], state.target[axis], `${scenario.name}, ${fps} fps, ${axis}, frame ${frame}`);
    }
    previous = actual;
  }
  close(previous.row, state.target.row, `${scenario.name} settles on the selected row`);
  close(previous.lane, state.target.lane, `${scenario.name} settles on the selected lane`);
}

// Apply the setting to the actual controller while a combined rail/light move
// is in flight. A zero-time edit preserves position; further frames obey the
// new pace without resetting to the selected cell or reviving reverse inertia.
const adjusted = setup();
adjusted.target = { row: 16, lane: 3 };
advance(adjusted, 0.2);
const beforeAdjustment = logicalLight(adjusted);
adjusted.light.setExperiment({ transitionDuration: 2.4 });
update(adjusted, 0);
for (const axis of ['row', 'lane']) close(logicalLight(adjusted)[axis], beforeAdjustment[axis],
  'Editing transition duration preserves the in-flight light position');
advance(adjusted, 1 / 60);
for (const axis of ['row', 'lane']) bounded(logicalLight(adjusted)[axis], beforeAdjustment[axis], adjusted.target[axis],
  'Live duration changes keep the light within its navigation range');
adjusted.light.setExperiment({ transitionDuration: 0.4 });
const beforeFastReverse = logicalLight(adjusted);
adjusted.target = { row: 9, lane: 0 };
advance(adjusted, 1 / 60);
for (const axis of ['row', 'lane']) bounded(logicalLight(adjusted)[axis], beforeFastReverse[axis], adjusted.target[axis],
  'Live faster pace and a reversal remain bounded');

for (const mode of ['area', 'hybrid', 'baseline', 'guided']) {
  const beforeMode = logicalLight(adjusted);
  adjusted.light.setExperiment({ mode });
  update(adjusted, 0);
  for (const axis of ['row', 'lane']) close(logicalLight(adjusted)[axis], beforeMode[axis],
    'Changing mode preserves the same in-flight light track');
  advance(adjusted, 1 / 60);
  for (const axis of ['row', 'lane']) {
    const actual = logicalLight(adjusted)[axis];
    bounded(actual, beforeMode[axis], adjusted.target[axis], 'Following continues smoothly through a mode switch');
    assert.ok(Math.abs(actual - adjusted.target[axis]) > EPSILON,
      'Mode comparison does not jump directly to the selected cell');
  }
}

// Rebase while the light is still moving. Logical coordinates remain absolute;
// local cells and array tracks shift by opposite amounts before the next frame.
const rebased = setup(3100, 2055);
rebased.target = { row: 3104, lane: 2057 };
advance(rebased, 1 / 30);
const beforeRebase = rebased.shell.uniforms.musicRowColumn.value.clone();
const beforeLogical = logicalLight(rebased);
const beforeModel = rebased.model.position.clone();
rebased.origin = { row: 3072, lane: 2052 };
rebased.rail.value += rebased.origin.row * ROW_LIGHTING.rowSpacing;
rebased.column.value -= rebased.origin.lane * ROW_LIGHTING.laneSpacing;
place(rebased);
assert.ok(rebased.model.position.distanceTo(beforeModel) < EPSILON, 'The real array rebase preserves the rendered selected model');
update(rebased, 0);
assert.ok(rebased.shell.uniforms.musicRowColumn.value.distanceTo(beforeRebase) < EPSILON,
  'Rebasing an in-flight array leaves the illuminated world position unchanged');
for (const axis of ['row', 'lane']) close(logicalLight(rebased)[axis], beforeLogical[axis], 'Rebase preserves logical light motion');
rebased.target = { row: 3097, lane: 2053 };
advance(rebased, 1 / 60);
for (const axis of ['row', 'lane']) bounded(logicalLight(rebased)[axis], beforeLogical[axis], rebased.target[axis], 'Reversal remains bounded after a rebase');
update(rebased, 0, true);
for (const axis of ['row', 'lane']) close(logicalLight(rebased)[axis], rebased.target[axis], 'Reduced motion snaps to the selected cell');

// Refreshing/reordering the library starts a new coordinate space, unlike a
// pool rebase. Old accumulated row/lane values must not leak into that space.
rebased.origin = { row: 0, lane: 0 };
rebased.target = { row: 12, lane: 0 };
rebased.light.resetRowMotion();
place(rebased); update(rebased, 1 / 60);
for (const axis of ['row', 'lane']) close(logicalLight(rebased)[axis], rebased.target[axis],
  'A nonempty library refresh discards the previous absolute coordinate history');

// Inspect actual production shader anchors across the complete 5.2 second
// opening, including the array's authored entry translation and final hold.
const intro = setup();
const introOffsets = [];
for (let frame = 0; frame <= 624; frame++) {
  const time = 21.92 + frame / 120;
  const entryProgress = Math.max(0, Math.min(1, (time - 21.92) / 0.75));
  place(intro, -23 * (1 - entryProgress) ** 2);
  update(intro, 1 / 120, false, time);
  const offset = logicalLight(intro).row - intro.target.row;
  close(offset, introRowOffset(time), 'Opening light follows the authored row offset in the rendered world');
  close(logicalLight(intro).lane, intro.target.lane, 'Opening light stays on the selected lane center');
  introOffsets.push(offset);
}
assert.ok(Math.max(...introOffsets) - Math.min(...introOffsets) > 15,
  'Opening visibly scans across more than fifteen rows instead of remaining on the selected row');
close(introRowOffset(27.12), 0, 'The final opening frame returns exactly to the selected row');
close(logicalLight(intro).row, intro.target.row, 'Rendered opening endpoint is the selected row');
update(intro, 1 / 60);
close(logicalLight(intro).row, intro.target.row, 'Opening completion has no delayed lighting tail');

for (const skipTime of [22.5, 23.4, 24.4, 25.5]) {
  const skipped = setup();
  place(skipped, -7); update(skipped, 1 / 60, false, skipTime);
  place(skipped); update(skipped, 1 / 60);
  close(logicalLight(skipped).row, skipped.target.row, `Skip at ${skipTime}s removes the sweep on the first archive frame`);
  for (let i = 0; i < 30; i++) update(skipped, 1 / 60);
  close(logicalLight(skipped).row, skipped.target.row, 'A skipped opening never springs back to its discarded sweep');
}

// Real shelves no longer share the same z origin. Drive the production light
// with the real independent-column controller, including a short/long handoff.
const independent = setup(12, 0);
independent.independentColumns = true;
const columns = new MusicRealColumns();
columns.reset([3, 80], independent.target);
function placeIndependent() {
  place(independent);
  independent.model.position.z = -2.17 + (independent.target.row -
    columns.row(independent.target.lane)) * ROW_LIGHTING.rowSpacing;
}
function advanceIndependent(dt, reduced = false) {
  columns.update(dt, reduced);
  placeIndependent();
  update(independent, dt, reduced);
}
placeIndependent(); update(independent, 0, true);
const worldRibbon = () => independent.shell.uniforms.musicRowColumn.value.clone();
function handoff(row, lane) {
  const before = worldRibbon();
  const areaZ = independent.light.area.position.z;
  independent.target = { row, lane };
  columns.select(independent.target, { guided: true });
  placeIndependent(); update(independent, 0);
  close(worldRibbon().z, before.z, 'Crossing independently centered columns preserves the displayed ribbon at zero elapsed time');
  close(independent.light.area.position.z, areaZ, 'The physical area light shares the same continuous row anchor');
}
handoff(12, 1);
for (let frame = 0; frame < 30; frame++) advanceIndependent(1 / 120);
handoff(14, 0); // Reverse before the long column has settled.
for (let frame = 0; frame < 10; frame++) advanceIndependent(1 / 120);
handoff(91, 1);
for (let frame = 0; frame < 120 * 12; frame++) advanceIndependent(1 / 120);
close(worldRibbon().z, independent.model.position.z, 'The remapped ribbon settles on the selected album of the long column');
close(logicalLight(independent).row, independent.target.row, 'Settled logical diagnostics use the new column coordinates');

// A same-column frame follows its shelf translation exactly; translating the
// basis every frame would introduce the old double filtering/rail lag again.
const sameColumnBefore = worldRibbon().z;
independent.model.position.z += 1.75;
update(independent, 0);
close(worldRibbon().z, sameColumnBefore + 1.75, 'Same-column shelf movement is applied once, without extra world-space filtering');

// Array-mode switches change bases even if the selected lane stays the same.
const modeBefore = worldRibbon().z;
independent.independentColumns = false;
independent.model.position.z -= 4;
update(independent, 0);
close(worldRibbon().z, modeBefore, 'Switching back to a shared array origin preserves the current ribbon');
independent.independentColumns = true;
placeIndependent(); update(independent, 0);
close(worldRibbon().z, modeBefore, 'Entering independently centered columns also preserves the current ribbon');
update(independent, 0, true);
close(worldRibbon().z, independent.model.position.z, 'Reduced motion bypasses basis history and lands on the selected album');

independent.light.resetRowMotion();
independent.target = { row: 12, lane: 0 };
columns.reset([3, 80], independent.target);
placeIndependent(); update(independent, 0);
close(worldRibbon().z, independent.model.position.z, 'Library reset clears the old independent basis together with its motion');
handoff(90, 1);
independent.light.update(independent.model, independent.camera, 0, false, false);
independent.target = { row: 14, lane: 0 };
columns.reset([3, 80], independent.target);
placeIndependent(); update(independent, 0);
close(worldRibbon().z, independent.model.position.z, 'Hiding and reinitializing the light cannot reuse an old column basis');

console.log('Row motion passed: adjustable 0.4–2.4s soft start/finish, 95% duration at 30/60/120 fps, matching rail rhythm; bounded bursts/reversals, live pace, rebase, reduced/opening/skip; independent short/long column handoffs and mode changes preserve world z, settle on target, retain exact same-column transforms and reset cleanly.');
