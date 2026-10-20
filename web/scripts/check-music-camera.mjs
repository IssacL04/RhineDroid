import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MusicCameraMotion, MusicPlacementMotion, MusicPresentation, musicArchiveOffset, musicArchiveTracksSettled, musicCinematicPose, musicExtractionAnchor } from '../src/music-camera.ts';
import { damp } from '../src/motion.ts';

for (const [width, height] of [[390, 844], [1080, 1920], [1049, 1000], [0, 0]]) {
  assert.deepEqual(musicArchiveOffset(width, height), { x: 0, y: 0 },
    'Portrait retains its own camera composition, including at the layout boundary');
}
for (const [width, height] of [[1050, 1000], [1024, 768], [1440, 900], [1920, 1080], [1280, 720]]) {
  assert.deepEqual(musicArchiveOffset(width, height), { x: 0, y: .08 },
    'Every landscape view through 16:9 reserves eight percent of its height above the raised album');
}
const halfwayOffset = musicArchiveOffset(2220, 1080);
assert.ok(Math.abs(halfwayOffset.x - .0175) < 1e-12 && Math.abs(halfwayOffset.y - .09) < 1e-12,
  'Intermediate wide screens gradually move left and add vertical headroom');
for (const [width, height] of [[2520, 1080], [2560, 1080], [3840, 1080]]) {
  assert.deepEqual(musicArchiveOffset(width, height), { x: .035, y: .1 },
    'Wide-screen movement is capped at 3.5 percent horizontally and ten percent vertically');
}
const scaleIndependent = musicArchiveOffset(3814, 1656), sameAspect = musicArchiveOffset(1907, 828);
assert.deepEqual(scaleIndependent, sameAspect, 'Matching aspect ratios use matching composition at different pixel densities');
for (const width of [1920, 2520]) {
  const before = musicArchiveOffset(width - .01, 1080), after = musicArchiveOffset(width + .01, 1080);
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 1e-10,
    'The 16:9 and 21:9 framing joins have no position or velocity jump');
}

function setup() {
  const camera = new THREE.PerspectiveCamera();
  const aim = new THREE.Vector3();
  camera.position.set(-62, 36, 43);
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(7.33 / (2 * camera.position.length())));
  const motion = new MusicCameraMotion();
  motion.observe(camera, aim, 0);
  return { camera, aim, motion };
}
const span = (camera, aim) => 2 * camera.position.distanceTo(aim) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
const target = new THREE.Vector3(-20, 17, 67), focus = new THREE.Vector3(2, 1, 0);
const a = setup(), b = setup();
const start = a.camera.position.clone();
a.motion.update(a.camera, a.aim, target, focus, 7.33, .1, false);
for (let frame = 0; frame < 12; frame++) b.motion.update(b.camera, b.aim, target, focus, 7.33, 1 / 120, false);
assert.ok(a.camera.position.distanceTo(b.camera.position) < 1e-9, 'Dolly is stable across frame rates');
assert.ok(a.aim.distanceTo(b.aim) < 1e-9);
assert.ok(a.camera.position.distanceTo(start) < target.distanceTo(start) * .25, 'The first 100 ms starts gently');
assert.ok(Math.abs(span(a.camera, a.aim) - 7.33) < 1e-9, 'Distance change does not produce a scale pulse');
const before = a.camera.position.clone();
a.motion.update(a.camera, a.aim, start, new THREE.Vector3(), 7.33, 1 / 120, false);
assert.ok(a.camera.position.x > before.x, 'A rapid reversal preserves existing velocity before braking');
for (let frame = 0; frame < 300; frame++) a.motion.update(a.camera, a.aim, start, new THREE.Vector3(), 5.9, 1 / 60, false);
assert.ok(a.camera.position.distanceTo(start) < 1e-10 && Math.abs(span(a.camera, a.aim) - 5.9) < 1e-10, 'Camera settles to exact framing');
a.motion.update(a.camera, a.aim, target, focus, 5.9, 0, true);
assert.deepEqual(a.camera.position.toArray(), target.toArray(), 'Reduced motion snaps');
assert.deepEqual(a.aim.toArray(), focus.toArray());

const film = setup();
film.camera.position.x += .1;
film.motion.observe(film.camera, film.aim, 1 / 60);
const handoff = film.camera.position.clone();
film.motion.update(film.camera, film.aim, handoff, film.aim.clone(), 7.33, 1 / 120, false);
assert.ok(film.camera.position.x > handoff.x, 'Opening camera velocity survives the interactive handoff');
assert.ok(film.camera.position.distanceTo(handoff) < .1, 'Handoff is continuous');

assert.deepEqual(musicExtractionAnchor(27.3), { x: 518, y: 288 }, 'Extraction starts at the previous shot corner');
const next = musicExtractionAnchor(27.3 + .001);
assert.ok(Math.hypot(next.x - 518, next.y - 288) < .000001, 'The shot boundary has no anchor jump');
const end = musicExtractionAnchor(34);
assert.deepEqual(end, { x: 420, y: 330 }, 'Oblique inspection holds its corner before the separate centering move');
assert.deepEqual(musicCinematicPose(29), musicCinematicPose(32.5), 'The close oblique shot has a real inspection pause');
const front = musicCinematicPose(34.56);
assert.deepEqual(front, { yaw: 0, elevation: 0, centered: 1, detail: 1 }, 'Film finishes face-on and centered');
const navigation = setup();
for (let frame = 0; frame < 180; frame++) {
  const orbit = navigation.motion.navigation(4, -5, 0, 1 / 60, false);
  assert.ok(Math.abs(orbit.yaw) <= .018 && Math.abs(orbit.elevation) <= .006, 'Browsing orbit stays subtle');
}
assert.deepEqual(navigation.motion.navigation(10, 10, 0, 0, true), { yaw: 0, elevation: 0 });

function verifyPresentation(hz, reduced = false) {
  const presentation = new MusicPresentation();
  const pan = new MusicPlacementMotion();
  const rig = setup();
  const archiveCamera = rig.camera.position.clone();
  const detailAim = new THREE.Vector3(2.6222222222, 1.85, 0);
  const yaw = THREE.MathUtils.degToRad(8), elevation = THREE.MathUtils.degToRad(20);
  const detailCamera = detailAim.clone().addScaledVector(new THREE.Vector3(
    -Math.sin(yaw) * Math.cos(elevation), Math.sin(elevation), Math.cos(yaw) * Math.cos(elevation),
  ), 72);
  const pose = (progress) => ({
    aim: detailAim.clone().multiplyScalar(progress),
    camera: archiveCamera.clone().lerp(detailCamera, progress),
    height: 7.33 + (5.9 - 7.33) * progress,
  });
  presentation.request('detail');
  assert.equal(presentation.phase, 'placing', 'Extraction and placement start in the same phase');
  assert.equal(presentation.placed, true, 'The shared movement starts without a frontal-centering gate');
  assert.equal(presentation.holdsDetail, true);
  const history = [presentation.phase];
  presentation.update(1, false, true, reduced);
  assert.equal(presentation.phase, 'placing', 'Placement readiness cannot bypass a moving camera');
  presentation.update(1, true, false, reduced);
  assert.equal(presentation.phase, 'placing', 'Camera readiness cannot bypass a moving extraction');
  for (let frame = 0; frame < hz * 8; frame++) {
    const progress = pan.update(Number(presentation.holdsDetail), 1 / hz, reduced);
    if (frame === 0) assert.ok(progress > 0, 'The first entry frame advances the common movement');
    const { aim, camera, height } = pose(progress);
    rig.motion.update(rig.camera, rig.aim, camera, aim, height, 1 / hz, reduced);
    const previous = presentation.phase;
    presentation.update(1 / hz,
      rig.motion.isSettled(rig.camera, rig.aim, camera, aim, height), pan.settled, reduced);
    if (previous !== presentation.phase) {
      history.push(presentation.phase);
      assert.ok(pan.settled, 'Presentation waits for the common extraction and placement endpoint');
      assert.ok(rig.motion.isSettled(rig.camera, rig.aim, camera, aim, height),
        'Presentation also waits for the displayed camera to settle');
    }
    if (presentation.phase === 'presented') break;
  }
  assert.deepEqual(history, ['placing', 'presented']);
  const displayedDirection = rig.camera.position.clone().sub(rig.aim).normalize();
  assert.ok(Math.abs(Math.asin(displayedDirection.y) - elevation) < .001,
    'The displayed detail camera preserves the elevated inspection angle');
  presentation.request('archive');
  assert.equal(presentation.phase, 'returning-center');
  presentation.returnWhenAligned(false);
  presentation.update(1, true, true, reduced);
  assert.equal(presentation.phase, 'returning-center', 'A manually rotated box must align before returning');
  assert.equal(presentation.holdsDetail, true, 'Alignment holds the shared extraction and camera endpoint');
  assert.equal(pan.update(Number(presentation.holdsDetail), 1 / hz, reduced), 1);
  presentation.returnWhenAligned(true);
  assert.equal(presentation.phase, 'returning-array', 'An aligned box begins the common return immediately');
  assert.equal(presentation.holdsDetail, false);
  history.push(presentation.phase);
  for (let frame = 0; frame < hz * 8; frame++) {
    const progress = pan.update(Number(presentation.holdsDetail), 1 / hz, reduced);
    const { aim, camera, height } = pose(progress);
    rig.motion.update(rig.camera, rig.aim, camera, aim, height, 1 / hz, reduced);
    const previous = presentation.phase;
    presentation.update(1 / hz,
      rig.motion.isSettled(rig.camera, rig.aim, camera, aim, height), pan.settled, reduced);
    if (previous !== presentation.phase) history.push(presentation.phase);
    if (presentation.phase === 'archive') break;
  }
  assert.deepEqual(history, ['placing', 'presented', 'returning-array', 'archive']);
  presentation.request('detail');
  presentation.request('archive');
  presentation.returnWhenAligned(true);
  assert.equal(presentation.phase, 'returning-array', 'An unrotated entry can reverse on its first return frame');
  presentation.request('detail');
  assert.equal(presentation.phase, 'placing', 'Rapid reversal resumes the same shared movement');
  presentation.returnWhenAligned(true);
  assert.equal(presentation.phase, 'placing', 'A stale alignment signal cannot undo a reopened detail');
  presentation.request('hidden');
  presentation.returnWhenAligned(true);
  assert.equal(presentation.phase, 'hidden', 'Replay clears all readiness');
  presentation.request('archive');
  assert.equal(presentation.phase, 'returning-array', 'Skip waits for the archive camera');
}
verifyPresentation(30);
verifyPresentation(120);
verifyPresentation(30, true);

function measurePan(hz) {
  const camera = new THREE.PerspectiveCamera();
  const aim = new THREE.Vector3(0, 1.85, 0);
  camera.position.set(0, 1.85, 72);
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(5.9 / 144));
  const motion = new MusicCameraMotion(), pan = new MusicPlacementMotion();
  motion.observe(camera, aim, 0);
  const shift = 5.9 * 16 / 9 * .25;
  let early = 0, t95 = null, previous = 0;
  for (let frame = 1; frame <= hz * 3; frame++) {
    const progress = pan.update(1, 1 / hz, false);
    const targetAim = new THREE.Vector3(progress * shift, 1.85, 0);
    const targetCamera = targetAim.clone().add(new THREE.Vector3(0, 0, 72));
    motion.update(camera, aim, targetCamera, targetAim, 5.9, 1 / hz, false);
    const displayed = aim.x / shift;
    assert.ok(displayed >= previous && displayed <= 1 + 1e-10, 'A full pan has no reversal or overshoot');
    previous = displayed;
    if (frame === hz / 5) early = displayed;
    if (t95 === null && displayed >= .95) t95 = frame / hz;
  }
  assert.ok(early < .005, 'The first 200 ms gently accelerates instead of travelling half the distance');
  assert.ok(t95 > 1.4 && t95 < 1.55, 'Actual 95% travel follows the long deceleration timing');
  return { early, t95 };
}
const pan30 = measurePan(30), pan120 = measurePan(120), pan240 = measurePan(240);
assert.ok(Math.abs(pan30.t95 - pan120.t95) < .05, 'Pan timing is stable at 30 and 120 Hz');
const interruptedPan = new MusicPlacementMotion();
interruptedPan.update(1, .55, false);
const state = [interruptedPan.value, interruptedPan.velocity, interruptedPan.acceleration];
interruptedPan.update(0, 0, false);
assert.deepEqual([interruptedPan.value, interruptedPan.velocity, interruptedPan.acceleration], state,
  'Retargeting the pan preserves position, velocity and acceleration');
interruptedPan.update(0, 1e-5, false);
assert.ok(Math.abs(interruptedPan.value - state[0]) < .0001 && Math.abs(interruptedPan.velocity - state[1]) < .001,
  'The first interrupted frame is continuous');
interruptedPan.update(1, 0, true);
assert.equal(interruptedPan.value, 1);
assert.equal(interruptedPan.velocity, 0);
assert.equal(interruptedPan.settled, true);

for (const hz of [30, 120]) {
  const presentation = new MusicPresentation();
  presentation.request('archive');
  presentation.update(.1, true, true, false);
  assert.equal(presentation.phase, 'archive');
  const tracks = Object.fromEntries(['rail', 'column', 'shoulder', 'lane'].map(key => [key, { value: 0, velocity: 0 }]));
  let targets = { rail: -.62, column: 5.2, shoulder: 1, lane: 1 };
  presentation.selectionChanged();
  assert.equal(presentation.phase, 'returning-array', 'Selecting a new cell invalidates readiness immediately');
  for (let frame = 0; frame < hz / 5; frame++) {
    for (const key of Object.keys(tracks)) damp(tracks[key], targets[key], 3.7, 1 / hz);
    presentation.update(1 / hz, true, musicArchiveTracksSettled(tracks, targets), false);
  }
  assert.equal(presentation.phase, 'returning-array', 'A settled camera cannot bypass the moving selection tracks');
  const previousSpeed = tracks.column.velocity;
  targets = { rail: -1.24, column: -5.2, shoulder: 2, lane: -1 };
  presentation.selectionChanged();
  assert.equal(tracks.column.velocity, previousSpeed, 'Rapid browsing keeps the existing track velocity');
  for (let frame = 0; frame < hz * 5; frame++) {
    for (const key of Object.keys(tracks)) damp(tracks[key], targets[key], 3.7, 1 / hz);
    presentation.update(1 / hz, true, musicArchiveTracksSettled(tracks, targets), false);
  }
  assert.equal(presentation.phase, 'archive', 'Readiness returns after all selected-cell tracks settle');
  for (const key of Object.keys(tracks)) {
    const speed = tracks[key].velocity;
    tracks[key].velocity = .1;
    assert.equal(musicArchiveTracksSettled(tracks, targets), false, `${key} velocity must settle too`);
    tracks[key].velocity = speed;
  }
}
console.log('Music camera passed: landscape headroom and framing boundaries, continuous motion, frame-rate independence, original-film oblique pause/frontal ending, shared entry/return gates, elevated detail, interruption, replay and reduced motion.');
console.log(`Presentation pan: ${(pan240.early * 100).toFixed(3)}% at 0.2 s; 95% at ${pan240.t95.toFixed(3)} s (rendered camera, 240 Hz).`);
