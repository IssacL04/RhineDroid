import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
import { MusicArchiveMotion, musicArchiveTravelDuration, ARCHIVE_TRACK_KEYS } from '../src/music-archive-motion.ts';
import { MusicPlacementMotion, MusicPresentation, musicArchiveTracksSettled } from '../src/music-camera.ts';
import { musicOverviewColumnExtent } from '../src/music-overview-edge.ts';
import { visibleCell, MUSIC_LOOP_ROWS, LOOP_COLUMNS } from '../src/archive-loop.ts';
import { damp } from '../src/motion.ts';
import { setMusicAlbums, records, archiveColumns, columnFiles, fileLocation } from '../src/data.ts';
import { selectionCell, sameCell, wrap, fileAtCell, nearestOccurrence, COLUMN_SPACING, ROW_SPACING } from '../src/archive-loop.ts';
import { MusicRealColumns } from '../src/music-real-columns.ts';

const rates = { column: 3.7, rail: 3.7, lane: 4, shoulder: 5 };
const target = (lanes, rows) => ({ column: lanes * 5.2, rail: -rows * .62, lane: lanes, shoulder: rows });
const zero = target(0, 0);
const tracks = () => Object.fromEntries(ARCHIVE_TRACK_KEYS.map(key => [key, { value: 0, velocity: 0 }]));
const close = (a, b, tolerance = 1e-9) => assert.ok(Number.isFinite(a) && Math.abs(a - b) <= tolerance,
  `${a} differs from ${b} by more than ${tolerance}`);

assert.equal(musicArchiveTravelDuration(1, 0), 1.4);
assert.equal(musicArchiveTravelDuration(0, 8), 1.4);
assert.equal(musicArchiveTravelDuration(8, 0), 2.4);
assert.equal(musicArchiveTravelDuration(0, 64), 2.4);
assert.equal(musicArchiveTravelDuration(-8, -100), 2.4);
for (const [lanes, rows] of [[1, 1], [4, 30], [-8, -120], [0, 64]]) {
  for (const fps of [20, 30, 60, 120]) for (const speed of [.25, 1, 3]) {
    const springs = tracks(), motion = new MusicArchiveMotion(), targets = target(lanes, rows);
    motion.observe(springs, zero, rates);
    motion.retarget(springs, targets);
    const presentation = new MusicPresentation();
    presentation.request('archive');
    let elapsed = 0, previous = 0;
    while (motion.active) {
      motion.update(springs, speed / fps, false);
      elapsed += 1 / fps;
      let normalized;
      for (const key of ARCHIVE_TRACK_KEYS) {
        if (!targets[key]) { close(springs[key].value, 0); continue; }
        const progress = springs[key].value / targets[key];
        assert.ok(progress >= previous - 1e-10 && progress <= 1 + 1e-10, 'Rest-to-rest travel is monotone');
        if (normalized !== undefined) close(progress, normalized);
        normalized = progress;
      }
      previous = normalized;
      presentation.update(speed / fps, true, motion.settled && musicArchiveTracksSettled(springs, targets), false);
      if (motion.active) assert.equal(presentation.phase, 'returning-array', 'No early readiness while trajectory runs');
      assert.ok(elapsed < 11, 'A slow long jump has a finite endpoint');
    }
    close(elapsed, motion.durationSeconds / speed, 1 / fps + 1e-9);
    for (const key of ARCHIVE_TRACK_KEYS) {
      assert.equal(springs[key].value, targets[key]);
      assert.equal(springs[key].velocity, 0);
      assert.equal(motion.state[key].acceleration, 0);
    }
    presentation.update(.081, true, musicArchiveTracksSettled(springs, targets), false);
    assert.equal(presentation.phase, 'archive', 'Readiness only needs its normal 80 ms settle hold');
  }
}

// Record why this change is perceptible: the old spring front-loads movement,
// while guided travel starts with the same gentle cadence as album placement.
const audit = [];
for (const [lanes, rows] of [[1, 0], [4, 30], [8, 80]]) {
  const springs = tracks(), motion = new MusicArchiveMotion();
  motion.retarget(springs, target(lanes, rows));
  motion.update(springs, .2, false);
  const oldRail = { value: 0, velocity: 0 }, placement = new MusicPlacementMotion();
  damp(oldRail, 1, 3.7, .2);
  placement.update(1, .2, false);
  const progress = springs.column.value / (lanes * 5.2);
  assert.ok(progress < .025, 'First 200 ms travels under 2.5%, even for a long jump');
  assert.ok(oldRail.value > progress * 7, 'The old early impulse is substantially reduced');
  audit.push({ lanes, rows, seconds: motion.durationSeconds.toFixed(3),
    old200msPercent: +(oldRail.value * 100).toFixed(3), new200msPercent: +(progress * 100).toFixed(3),
    detail200msPercent: +(placement.value * 100).toFixed(3) });
}

for (const initialTime of [.12, .7, 1.2]) {
  const springs = tracks(), motion = new MusicArchiveMotion();
  motion.retarget(springs, target(4, 30));
  motion.update(springs, initialTime, false);
  const before = motion.state;
  motion.retarget(springs, target(-2, -10));
  assert.deepEqual(motion.state, before, 'A reversed search preserves position, velocity and acceleration');
  motion.update(springs, 0, false);
  assert.deepEqual(motion.state, before, 'A zero-time retarget frame is also continuous');
  motion.update(springs, 1e-6, false);
  for (const key of ARCHIVE_TRACK_KEYS) {
    close(motion.state[key].value, before[key].value, .001);
    close(motion.state[key].velocity, before[key].velocity, .001);
    close(motion.state[key].acceleration, before[key].acceleration, .01);
  }
  // Rebase as the production scene does: translate rendered springs and the
  // stored polynomial by the same amount, then continue the same timeline.
  const shift = target(-2100, 8000), old = motion.state, progress = motion.progress;
  for (const key of ARCHIVE_TRACK_KEYS) springs[key].value += shift[key];
  motion.translate(shift);
  assert.equal(motion.progress, progress);
  for (const key of ARCHIVE_TRACK_KEYS) {
    close(motion.state[key].value, old[key].value + shift[key]);
    assert.equal(motion.state[key].velocity, old[key].velocity);
    assert.equal(motion.state[key].acceleration, old[key].acceleration);
  }
  motion.update(springs, 3, false);
  for (const key of ARCHIVE_TRACK_KEYS) close(springs[key].value, target(-2, -10)[key] + shift[key]);
}

// A request during ordinary spring browsing inherits its exact acceleration.
const browsing = tracks(), handoff = new MusicArchiveMotion(), browsingTarget = target(1, 8);
for (const key of ARCHIVE_TRACK_KEYS) damp(browsing[key], browsingTarget[key], rates[key], .2);
handoff.observe(browsing, browsingTarget, rates);
const handoffState = handoff.state;
handoff.retarget(browsing, target(-3, 25));
assert.deepEqual(handoff.state, handoffState);
for (const speed of [.25, 3, 1, .25, 3]) {
  const state = handoff.state;
  handoff.update(browsing, 0 * speed, false);
  assert.deepEqual(handoff.state, state, 'Changing speed changes elapsed time, not the state at that instant');
  handoff.update(browsing, speed / 120, false);
}
handoff.update(browsing, 0, true);
assert.equal(handoff.settled, true, 'Reduced motion completes immediately during a running search');
for (const key of ARCHIVE_TRACK_KEYS) {
  assert.equal(browsing[key].value, target(-3, 25)[key]);
  assert.equal(browsing[key].velocity, 0);
}

// Every recycle occurs at zero height on either side, including negative and
// rebased coordinates. Standard view and the intro retain full-size instances.
for (const lane of [-2052, -9, 0, 8, 2052]) {
  assert.equal(musicOverviewColumnExtent(lane, lane, 1), 1);
  assert.equal(musicOverviewColumnExtent(lane, lane + 3.5, 1), 1);
  assert.equal(musicOverviewColumnExtent(lane, lane + 4.5, 1), 0);
  assert.equal(musicOverviewColumnExtent(lane, lane - 4.5, 1), 0);
  assert.equal(musicOverviewColumnExtent(lane, lane + 4.5, 0), 1);
  assert.equal(musicOverviewColumnExtent(lane, lane + 4.5, .65), 0);
  for (let position = -20; position <= 20; position += .037) {
    const extent = musicOverviewColumnExtent(lane, lane + position, 1);
    assert.ok(extent >= 0 && extent <= 1);
  }
}
let recycleCount = 0;
for (let center = -12; center < 12; center += .005) {
  for (let i = 0; i < LOOP_COLUMNS; i++) {
    const previous = visibleCell(i * MUSIC_LOOP_ROWS, { lane: center, row: 12 }, MUSIC_LOOP_ROWS);
    const next = visibleCell(i * MUSIC_LOOP_ROWS, { lane: center + .005, row: 12 }, MUSIC_LOOP_ROWS);
    if (previous.lane === next.lane) continue;
    recycleCount++;
    assert.ok(musicOverviewColumnExtent(previous.lane, center, 1) < .000002);
    assert.ok(musicOverviewColumnExtent(next.lane, center + .005, 1) < .000002);
  }
}
assert.ok(recycleCount > 20, 'Exercise actual pool recycling in both coordinate signs');

const scene = fs.readFileSync(new URL('../src/scene.ts', import.meta.url), 'utf8');
assert.match(scene, /this\.musicArchiveMotion\.update\(archiveTracks, dt, this\.reduced\)/,
  'Global speed is applied once by the existing scene clock');
assert.match(scene, /this\.musicArchiveMotion\.settled && tracksSettled/,
  'Presentation readiness waits for the exact guided endpoint');
assert.match(scene, /this\.applyMusicColumnExtent\(o\.group/, 'Returning copies share the edge envelope');
assert.match(scene, /this\.applyMusicColumnExtent\(this\.model/, 'The selected box shares the edge envelope');
console.table(audit);
console.log('Archive travel passed: synchronized rest-to-rest paths, 20/30/60/120 fps, 0.25/1/3× timing, reduced motion, C2 retarget and spring handoff, rebase, readiness and zero-height pool recycling.');

// Exercise the actual app selection/memory functions and scene selection/track
// branch. Only DOM, audio, extracted-card geometry and camera/lift completion
// are replaced; destinations, navigation intent and motion dispatch are real.
const appSource = fs.readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8');
const appTree = ts.createSourceFile('music-app.ts', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const sceneTree = ts.createSourceFile('scene.ts', scene, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const sceneClass = sceneTree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ArchiveScene');
const transpile = code => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const appFunction = name => {
  const node = appTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, `Production app ${name} must exist`);
  return node.getText(appTree);
};
const sceneMethod = name => {
  const node = sceneClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(sceneTree) === name);
  assert.ok(node?.body, `Production scene ${name} must exist`);
  return `${name}(${node.parameters.map(parameter => parameter.getText(sceneTree)).join(',')}) ${node.body.getText(sceneTree)}`;
};
const sceneMethodsFactory = new Function('THREE', 'musicLibrary', 'records', 'fileLocation', 'selectionCell',
  'sameCell', 'COLUMN_SPACING', 'ROW_SPACING', transpile(`return {
    ${['select', 'switchMusicAlbum', 'cellPosition', 'musicBrowseRowForColumn'].map(sceneMethod).join(',\n')}
  };`));
const updateMethod = sceneClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(sceneTree) === 'update');
const trackStart = updateMethod.body.statements.findIndex(node => ts.isVariableStatement(node) &&
  node.declarationList.declarations.some(declaration => declaration.name.getText(sceneTree) === 'chosen'));
const trackEnd = updateMethod.body.statements.findIndex((node, index) => index > trackStart &&
  ts.isIfStatement(node) && node.expression.getText(sceneTree) === 'detailNavigation && this.reduced');
assert.ok(trackStart >= 0 && trackEnd > trackStart, 'Extract the production archive track dispatch without copying its condition');
const realColumnUpdate = updateMethod.body.statements.find(node =>
  ts.isIfStatement(node) && node.getText(sceneTree).includes('this.musicRealColumns.update('));
assert.ok(realColumnUpdate, 'Production real-column advancement belongs to the same scene frame');
const advanceTracks = new Function('musicLibrary', 'damp', 'MUSIC_ALBUM_SWITCH_RATE', transpile(`
  return function(dt) {
    const cinematic = undefined;
    ${updateMethod.body.statements.slice(trackStart, trackEnd + 1).map(node => node.getText(sceneTree)).join('\n')}
    ${realColumnUpdate.getText(sceneTree)}
  };
`))(true, damp, 9);
const presentationCode = transpile(fs.readFileSync(new URL('../src/music-presentation.ts', import.meta.url), 'utf8'));
const { MusicPresentation: AlbumPresentation } = await import(`data:text/javascript;base64,${Buffer.from(presentationCode).toString('base64')}`);

function navigationFixture(mode = 'filled', reduced = false, speed = 1) {
  const counts = [106, 55, 1];
  const albums = counts.flatMap((count, lane) => Array.from({ length: count }, (_, row) => ({
    id: `lane${lane}-album${row}`, title: `Album ${row}`, artist: `Artist ${lane}`, genreId: `g${lane}`,
    folder: '', tracks: [], producers: [], rawGenres: [], offline: false,
  })));
  setMusicAlbums(albums, counts.map((_, lane) => ({ id: `g${lane}`, name: `Artist ${lane}` })));
  const location = fileLocation(0);
  const sceneHost = {
    loaded: true, looping: true, reduced, musicArrayMode: mode,
    musicPresentation: new MusicPresentation(), musicArchiveMotion: new MusicArchiveMotion(), musicNavigationLift: false,
    musicRealColumns: new MusicRealColumns(), musicOverview: { value: 0 },
    selectedSlot: location.slot, selectedCell: { lane: location.lane, row: location.row },
    lift: { value: 0, velocity: 0 }, rail: { value: -2.17 - (location.row - 15.5) * ROW_SPACING, velocity: 0 },
    columnCamera: { value: (location.lane - 2) * COLUMN_SPACING, velocity: 0 },
    shoulder: { value: location.row, velocity: 0 }, laneFocus: { value: location.lane, velocity: 0 },
    outgoing: [], decryption: { select() {}, enter() {}, clarity: 0 }, deferSelectionPulse: true,
    clock: 0, lastInteraction: 0, targetRotation: 0, rotation: 0, returnY: null,
    get musicBrowseRow() { return (-this.rail.value - 2.17) / ROW_SPACING + 15.5; },
    ...sceneMethodsFactory(THREE, true, records, fileLocation, selectionCell, sameCell, COLUMN_SPACING, ROW_SPACING),
  };
  sceneHost.musicRealColumns.reset(counts, sceneHost.selectedCell);
  sceneHost.musicPresentation.request('archive');
  sceneHost.musicPresentation.update(.1, true, true, false);
  const springs = () => ({ rail: sceneHost.rail, column: sceneHost.columnCamera,
    shoulder: sceneHost.shoulder, lane: sceneHost.laneFocus });
  const goals = () => {
    const chosen = sceneHost.cellPosition(sceneHost.selectedCell);
    return { rail: -2.17 - chosen.z, column: chosen.x, shoulder: sceneHost.selectedCell.row, lane: sceneHost.selectedCell.lane };
  };
  sceneHost.musicArchiveMotion.observe(springs(), goals(), rates);
  const api = new Function('records', 'archiveColumns', 'columnFiles', 'fileLocation', 'fileAtCell', 'nearestOccurrence', 'wrap', 'scene', 'AlbumPresentation', 'arrayMode', transpile(`
    let selected = 0, libraryRebuilding = false, libraryIntent;
    const ready = true, boot = { active: false };
    const preferences = { rememberColumnPosition: true, arrayMode };
    const columnMemory = new Map(archiveColumns.map((name, lane) => [name, records[columnFiles(lane)[0]].id]));
    const updateSelection = () => {}, cancelTrackReveal = () => {}, syncAlbumNavigation = () => {};
    const effects = { play() {} }, overviewUI = { collapse() {} };
    const presentation = new AlbumPresentation({
      archiveReady: () => scene.musicPresentation.phase === 'archive',
      archiveInteractive: () => scene.musicPresentation.phase === 'archive',
      presentationReady: () => scene.musicPresentation.phase === 'presented',
      enterCamera: () => scene.musicPresentation.request('detail'),
      returnCamera: () => { scene.musicPresentation.request('archive'); scene.musicPresentation.returnWhenAligned(true); },
      select: ({ index, navigation }) => commitSelection(index, navigation),
      switchDetail: ({ index, navigation }) => commitSelection(index, navigation, true),
      prepareMenu() {}, showMenu() {}, showBrowse() {}, mode() {},
      hideMenu: done => done(), hideBrowse: done => done(),
    });
    ${['commitSelection', 'select', 'navigationSelection', 'resolveColumnSelection', 'stepAlbum', 'stepGenre'].map(appFunction).join('\n')}
    return { select, stepAlbum, stepGenre, presentation,
      setRememberColumnPosition: value => { preferences.rememberColumnPosition = value; },
      get selected() { return selected; }, get memory() { return new Map(columnMemory); } };
  `))(records, archiveColumns, columnFiles, fileLocation, fileAtCell, nearestOccurrence, wrap, sceneHost, AlbumPresentation, mode);
  const step = (frames = 1) => {
    for (let frame = 0; frame < frames; frame++) {
      const dt = (reduced ? 1 : speed) / 120;
      sceneHost.clock += 1 / 120;
      advanceTracks.call(sceneHost, dt);
      sceneHost.musicPresentation.returnWhenAligned(true);
      const settled = sceneHost.musicArchiveMotion.settled && musicArchiveTracksSettled(springs(), goals()) &&
        (mode !== 'realistic' || sceneHost.musicRealColumns.settled(sceneHost.selectedCell.lane));
      sceneHost.musicPresentation.update(dt, true, settled, reduced);
      if (sceneHost.musicPresentation.phase === 'archive') sceneHost.musicNavigationLift = false;
      api.presentation.update();
    }
  };
  const settle = (phase = 'archive') => {
    for (let frame = 0; frame < 120 * 15 / speed; frame++) {
      step();
      if (api.presentation.phase === phase && sceneHost.musicArchiveMotion.settled &&
        musicArchiveTracksSettled(springs(), goals()) &&
        (mode !== 'realistic' || sceneHost.musicRealColumns.settled(sceneHost.selectedCell.lane)) &&
        sceneHost.musicPresentation.phase === (phase === 'detail' ? 'presented' : 'archive')) return;
    }
    assert.fail(`Navigation did not settle into ${phase} (${mode}, ${speed}×)`);
  };
  return { api, scene: sceneHost, step, settle, springs, goals,
    index: (lane, row) => records.findIndex(record => record.id === `lane${lane}-album${row}`) };
}

for (const mode of ['filled', 'realistic']) {
  const f = navigationFixture(mode), remembered = f.index(1, 30);
  f.api.select(remembered, undefined, true, 'archive');
  f.settle('detail');
  assert.equal(f.scene.musicArchiveMotion.active, false, 'Completed search has no surviving guided task');
  f.api.presentation.back();
  f.settle();
  f.api.stepGenre(1); f.settle(); // One-album neighbour.
  f.api.stepGenre(1); f.settle(); // The 106-album artist.
  for (let i = 0; i < 5; i++) { f.api.stepAlbum(1); f.settle(); }
  const previousRow = f.scene.selectedCell.row;
  f.api.stepGenre(1); // Revisit the 55-album artist's remembered search result.
  assert.equal(f.api.selected, remembered, 'Returning to the artist preserves its last selected album');
  assert.equal(f.api.memory.get(archiveColumns[1]), records[remembered].id,
    'Search memory is retained rather than hidden by clearing it');
  assert.equal(Math.abs(f.scene.selectedCell.row - previousRow), 25,
    'The isolated 55/106-album library reproduces a distant row restoration');
  assert.equal(f.scene.musicArchiveMotion.active, true,
    `${mode}: a distant remembered row reached by a lane move must use guided motion`);
  const before = f.scene.rail.value, distance = f.goals().rail - before;
  f.step(24); // 200 ms at the default 1×.
  assert.ok(Math.abs((f.scene.rail.value - before) / distance) < .025,
    'Remembered-row restoration receives the same gentle start as search');
  // New directional input during that movement inherits the actual x/v/a.
  const state = f.scene.musicArchiveMotion.state;
  f.api.stepGenre(1);
  assert.deepEqual(f.scene.musicArchiveMotion.state, state, 'A rapid next-column input preserves every derivative');
  const reversed = f.scene.musicArchiveMotion.state;
  f.api.stepGenre(-1);
  assert.deepEqual(f.scene.musicArchiveMotion.state, reversed, 'Immediate lane reversal also preserves every derivative');
  f.settle();
  assert.equal(f.api.selected, remembered, 'Rapid crossing and reversal still land on the intended remembered album');
  const chosen = f.scene.selectedCell;
  const index = f.api.selected;
  f.step(120 * 3);
  assert.equal(f.api.selected, index, 'No delayed search destination is committed after navigation settles');
  assert.deepEqual(f.scene.selectedCell, chosen);
}

for (const mode of ['filled', 'realistic']) {
  const f = navigationFixture(mode);
  f.api.stepGenre(1);
  assert.equal(f.scene.musicArchiveMotion.active, false, 'Same-row neighbouring columns retain ordinary browsing speed');
  f.settle();
  f.api.stepAlbum(1);
  assert.equal(f.scene.musicArchiveMotion.active, false, 'Ordinary next-album input retains ordinary browsing speed');
  f.settle();
  f.api.stepGenre(-1);
  assert.equal(f.scene.musicArchiveMotion.active, false, 'A one-row memory difference stays on the normal browsing path');
  f.settle();
  f.api.select(f.index(1, 30), undefined, true, 'archive');
  f.settle('detail');
  f.api.stepGenre(-1);
  assert.equal(f.scene.musicNavigationLift, true, 'Detail navigation retains its independent lift ownership');
  assert.equal(f.scene.musicArchiveMotion.active, false, 'Distant detail switches do not enter the archive search trajectory');
  f.settle('detail');
}

for (const speed of [.25, 3]) for (const reduced of [false, true]) {
  const f = navigationFixture('filled', reduced, speed);
  f.api.select(f.index(1, 30), undefined, true, 'archive'); f.settle('detail');
  f.api.presentation.back(); f.settle();
  f.api.stepGenre(-1); f.settle();
  f.api.stepGenre(1);
  assert.equal(f.scene.musicArchiveMotion.active, true, 'Distant lane restoration selects guided motion at every saved speed');
  f.step();
  if (reduced) assert.equal(f.scene.musicArchiveMotion.active, false, 'Reduced motion completes the remembered-row trajectory immediately');
  f.settle();
}

for (const mode of ['filled', 'realistic']) {
  const rememberedEntry = navigationFixture(mode);
  rememberedEntry.api.select(rememberedEntry.index(1, 0), undefined, false);
  const duration = rememberedEntry.scene.musicArchiveMotion.durationSeconds;
  rememberedEntry.step(24);
  const rememberedProgress = rememberedEntry.scene.columnCamera.value;

  const nearbyEntry = navigationFixture(mode), cell = { lane: 1, row: 12 };
  nearbyEntry.api.setRememberColumnPosition(false);
  nearbyEntry.api.select(nearbyEntry.index(1, 0), { cell, guided: true }, false);
  assert.equal(nearbyEntry.scene.musicArchiveMotion.active, true,
    'Overview entry with memory off preserves guided motion even for a short exact-cell move');
  assert.equal(nearbyEntry.scene.musicArchiveMotion.durationSeconds, duration,
    'Memory on and off give equivalent overview entries the same authored duration');
  nearbyEntry.step(24);
  close(nearbyEntry.scene.columnCamera.value, rememberedProgress);
  nearbyEntry.settle();
  assert.deepEqual(nearbyEntry.scene.selectedCell, cell, 'Guided entry retains the exact physical cell');

  const ordinaryClick = navigationFixture(mode);
  ordinaryClick.api.setRememberColumnPosition(false);
  ordinaryClick.api.select(ordinaryClick.index(1, 0), { cell }, false);
  assert.equal(ordinaryClick.scene.musicArchiveMotion.active, false,
    'A plain nearby card click with an exact cell retains the original spring path');
  ordinaryClick.step(24);
  assert.ok(ordinaryClick.scene.columnCamera.value > rememberedProgress,
    'Ordinary card clicks retain their faster initial response');
  ordinaryClick.settle();
  assert.deepEqual(ordinaryClick.scene.selectedCell, cell);
}
console.log('Production remembered-row navigation passed: search, back, neighbouring-artist browsing, 55/106-album filled and realistic restoration, rapid lane changes/reversal, close moves, detail switches, 0.25/3× reduced motion, guided exact-cell overview entry and ordinary exact-cell clicks.');
