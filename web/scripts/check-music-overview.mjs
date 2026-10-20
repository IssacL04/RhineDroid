import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as THREE from 'three';
import { MusicOverviewMotion, overviewFraming, visibleOverviewLabels } from '../src/music-overview.ts';
import { isRealAlbumCell } from '../src/music-array-layout.ts';
import { visibleCell, MUSIC_LOOP_ROWS, LOOP_COLUMNS, COLUMN_SPACING, ROW_SPACING } from '../src/archive-loop.ts';
import { setMusicAlbums, archiveColumns, columnFiles, musicLibrary } from '../src/data.ts';
import { MUSIC_MODEL } from '../src/music-model.ts';
import { musicOverviewColumnExtent } from '../src/music-overview-edge.ts';
import { MusicRealColumns } from '../src/music-real-columns.ts';

for (const fps of [20, 30, 60, 120]) {
  const motion = new MusicOverviewMotion();
  motion.active = true;
  let previous = 0;
  for (let i = 0; i < fps * 3; i++) {
    const value = motion.update(1 / fps, false);
    assert.ok(value >= previous && value <= 1);
    previous = value;
  }
  assert.ok(motion.value > .9999);
  motion.active = false;
  for (let i = 0; i < fps * 3; i++) motion.update(1 / fps, false);
  assert.ok(motion.value < .0001);
  motion.active = true;
  assert.equal(motion.update(0, true), 1);
  motion.reset(); assert.equal(motion.value, 0);
}
for (const [w, h] of [[390, 844], [1280, 720], [1920, 1080], [2560, 1080]]) {
  const framing = overviewFraming(w, h);
  assert.ok(framing.span >= 16.8);
  const labels = visibleOverviewLabels([
    {lane:0,name:'Selected',count:3,x:w/2,y:h/2,selected:true},
    {lane:1,name:'Overlap',count:9,x:w/2+60,y:h/2,selected:false},
    {lane:2,name:'Offscreen',count:1,x:0,y:h/2,selected:false},
  ], w, h);
  assert.deepEqual(labels.map(label=>label.lane), [0]);
}
// Use the actual finite render mask over the real 9 x 48 display pool.
for (const counts of [[1], [2,1], [0,1,7], [48,49,100]]) {
  for (const center of [{lane:0,row:12}, {lane:1,row:36}, {lane:2,row:96}]) {
    const rendered = Array.from({length:LOOP_COLUMNS*MUSIC_LOOP_ROWS}, (_,i)=>visibleCell(i,center,MUSIC_LOOP_ROWS))
      .filter(cell=>isRealAlbumCell(cell.lane,cell.row,counts));
    const identities=rendered.map(cell=>`${cell.lane}:${cell.row}`);
    assert.equal(new Set(identities).size, identities.length, 'No album is duplicated in real shelves');
    for (const cell of rendered) assert.ok(cell.row - 12 < counts[cell.lane]);
    if (counts.length===2 && center.row===12) assert.equal(rendered.length,3,'Two plus one albums render exactly three boxes');
  }
}
for (const [lane,row] of [[-1,12],[0,11],[0,14],[2,12],[0,12.5]])
  assert.equal(isRealAlbumCell(lane,row,[2,1]),false);

// Exercise ArchiveScene's actual projection and pool methods with a real Three
// camera, avoiding browser/WebGL construction. Extract method bodies and parameters
// unchanged from production, with the production library data view injected.
const source = ts.createSourceFile('scene.ts', await readFile(new URL('../src/scene.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const methodNames = ['getOverviewColumns', 'musicColumnRowOffset', 'visibleMusicCell', 'musicColumnExtent', 'applyMusicColumnExtent'];
const methodBodies = new Map();
function findMethods(node) {
  if (ts.isMethodDeclaration(node) && methodNames.includes(node.name.getText(source))) {
    assert.ok(node.body, `Production ${node.name.getText(source)} method must have a body`);
    methodBodies.set(node.name.getText(source), {
      parameters: node.parameters.map(parameter => parameter.getText(source)).join(', '),
      body: node.body.getText(source),
    });
  }
  ts.forEachChild(node, findMethods);
}
findMethods(source);
for (const name of methodNames) assert.ok(methodBodies.has(name), `Production ${name} method must exist`);
const methodsBody = ts.transpileModule(`return {${methodNames.map(name => {
  const method = methodBodies.get(name);
  return `${name}(${method.parameters}) ${method.body}`;
}).join(',')}}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const productionMethods = ({ music = musicLibrary } = {}) => new Function('THREE', 'archiveColumns', 'columnFiles',
  'COLUMN_SPACING', 'ROW_SPACING', 'MUSIC_MODEL', 'musicLibrary', 'visibleCell', 'musicOverviewColumnExtent', methodsBody)(
  THREE, archiveColumns, columnFiles, COLUMN_SPACING, ROW_SPACING, MUSIC_MODEL, music, visibleCell, musicOverviewColumnExtent);

function projectionFixture(counts, { selectedLane = 0, browsingRow = 12, mode = 'realistic', overview = 0, width = 1280, height = 720 } = {}) {
  const genres = counts.map((_, lane) => ({ id: `g${lane}`, name: `列 ${lane}` }));
  const albums = genres.flatMap((genre, lane) => Array.from({ length: counts[lane] }, (_, index) => ({
    id: `${genre.id}-${index}`, title: `专辑 ${index}`, artist: '测试歌手', genreId: genre.id,
    rawGenres: [], folder: '', tracks: [], producers: [], offline: false,
  })));
  setMusicAlbums(albums, genres);
  const framing = overviewFraming(width, height), yaw = THREE.MathUtils.degToRad(framing.yaw), elevation = THREE.MathUtils.degToRad(framing.elevation);
  const target = new THREE.Vector3(0, -1.8, -1.5);
  const direction = new THREE.Vector3(-Math.sin(yaw) * Math.cos(elevation), Math.sin(elevation), Math.cos(yaw) * Math.cos(elevation));
  const camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2 * Math.atan(framing.span / (2 * framing.distance))), width / height, .1, 500);
  camera.position.copy(target).addScaledVector(direction, framing.distance);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  const selectedRow = Math.max(12, Math.min(11 + (counts[selectedLane] || 1), browsingRow));
  const musicRealColumns = new MusicRealColumns();
  musicRealColumns.reset(counts, { lane: selectedLane, row: selectedRow });
  const host = {
    loaded: true, looping: true, container: { clientWidth: width, clientHeight: height }, camera,
    columnExtentOffset: new THREE.Vector3(),
    columnCamera: { value: (selectedLane - 2) * COLUMN_SPACING },
    selectedCell: { lane: selectedLane, row: mode === 'realistic' ? selectedRow : browsingRow },
    rail: { value: -2.17 - (browsingRow - 15.5) * ROW_SPACING },
    musicArrayMode: mode, musicOverview: { value: overview }, musicRealColumns,
    get musicBrowseRow() { return (-this.rail.value - 2.17) / ROW_SPACING + 15.5; },
    musicColumnCounts: counts, poolRows: MUSIC_LOOP_ROWS,
    ...productionMethods(),
  };
  const project = host.getOverviewColumns;
  // Assert against the screen position of a known actual card, rather than
  // reimplementing the clamp/nearest-occurrence algorithm under test.
  const actualCardAnchor = (lane, row) => {
    const center = mode === 'realistic' ? musicRealColumns.row(lane, host.musicOverview.value) : browsingRow;
    const point = new THREE.Vector3((lane - selectedLane) * COLUMN_SPACING,
      -4.6 + MUSIC_MODEL.center.y + MUSIC_MODEL.height / 2 + .65,
      -2.17 + (row - center) * ROW_SPACING).project(camera);
    return { x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2 };
  };
  const assertAnchor = (label, lane, row, message) => {
    assert.ok(label, `${message}: label exists`);
    const expected = actualCardAnchor(lane, row);
    assert.ok(Math.abs(label.x - expected.x) < 1e-8 && Math.abs(label.y - expected.y) < 1e-8,
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify({ x: label.x, y: label.y })}`);
  };
  return { host, project, actualCardAnchor, assertAnchor, labels: () => project.call(host), width, height };
}

// Execute the production geometry transform: it must preserve the local base
// through rotation while leaving cover width and depth unchanged.
{
  const f = projectionFixture([1, 1, 1, 1, 1], { overview: 1 });
  const bottom = MUSIC_MODEL.center.y - MUSIC_MODEL.height / 2;
  for (const rotation of [0, .08, -.08]) for (const extent of [.001, .2, .5, 1]) {
    const object = new THREE.Object3D();
    object.position.set(5, -4.6, 2);
    object.rotation.set(rotation, .15, 0);
    object.updateMatrixWorld(true);
    const base = object.localToWorld(new THREE.Vector3(0, bottom, 0));
    f.host.applyMusicColumnExtent(object, extent);
    object.updateMatrixWorld(true);
    assert.ok(object.localToWorld(new THREE.Vector3(0, bottom, 0)).distanceTo(base) < 1e-10,
      'Overview unfolding keeps each rotated case base fixed');
    assert.deepEqual(object.scale.toArray(), [1, extent, 1], 'Only vertical extent changes');
  }
  const before = f.labels().find(label => label.lane === 4);
  f.host.musicOverview.value = 0;
  const full = f.labels().find(label => label.lane === 4);
  assert.ok(before.y > full.y, 'A label follows its partially unfolded edge column');
}

for (const [width, height] of [[2560, 1080], [3806, 1622]]) {
  const f = projectionFixture(Array(10).fill(1), { overview: 1, width, height });
  for (const distance of [4.01, 4.2, 4.49, 4.5]) {
    const centerLane = 4 - distance;
    f.host.columnCamera.value = (centerLane - 2) * COLUMN_SPACING;
    const label = f.labels().find(column => column.lane === 4);
    assert.ok(label, 'Wide-screen labels retain live projection after the previous four-column cutoff');
    const extent = f.host.musicColumnExtent(4);
    assert.equal(label.extent, extent, 'UI receives the same continuous visibility as the case');
    const object = new THREE.Object3D();
    object.position.set(distance * COLUMN_SPACING, -4.6, -2.17);
    f.host.applyMusicColumnExtent(object, extent);
    object.updateMatrixWorld(true);
    if (extent > 0) {
      const point = object.localToWorld(new THREE.Vector3(0,
        MUSIC_MODEL.center.y + MUSIC_MODEL.height / 2 + .65, 0)).project(f.host.camera);
      assert.ok(Math.abs(label.x - (point.x + 1) * width / 2) < 1e-8 &&
        Math.abs(label.y - (1 - point.y) * height / 2) < 1e-8,
      'The retiring label follows the actual unfolded column in both screen axes');
    }
  }
  f.host.columnCamera.value = (-.51 - 2) * COLUMN_SPACING;
  assert.ok(!f.labels().some(column => column.lane === 4), 'Projection retires only beyond the zero-height boundary');
}

for (const [width, height] of [[393,852], [1280,720], [2560,1080]]) {
  const f = projectionFixture([50,1], { browsingRow: 61, width, height });
  const labels = f.labels();
  assert.deepEqual(labels.map(label => [label.lane, label.count, label.selected]), [[0,50,true], [1,1,false]]);
  f.assertAnchor(labels[0], 0, 61, 'The current long column stays attached to its 50th album');
  f.assertAnchor(labels[1], 1, 12, 'The one-album neighbour stays attached to its only album');
  const actual = Array.from({length:LOOP_COLUMNS*MUSIC_LOOP_ROWS}, (_,i)=>f.host.visibleMusicCell(i,{lane:0,row:61}))
    .filter(cell=>isRealAlbumCell(cell.lane,cell.row,[50,1]));
  assert.equal(actual.filter(cell=>cell.lane===1).length, 1,
    'A short neighbour remains rendered while the current column reaches its last album');
  assert.ok(Math.abs(labels[1].y - f.actualCardAnchor(1, 12).y) < 1e-8,
    'The one-album label stays on its centered actual card at every viewport size');
}

{
  const f = projectionFixture([50,3,50], { browsingRow: 18 });
  const labels = f.labels();
  f.assertAnchor(labels.find(label=>label.lane===1), 1, 13, 'A short inactive neighbour uses its middle album');
  f.assertAnchor(labels.find(label=>label.lane===2), 2, 36.5, 'A long inactive neighbour keeps its geometric midpoint');
}
{
  const f = projectionFixture([50,3], { browsingRow: 10 });
  for (const label of f.labels()) f.assertAnchor(label, label.lane,
    label.lane === 0 ? 12 : 13,
    'A global rail before the first row cannot displace an independently centered neighbour');
}
for (const [selectedLane, physicalLanes] of [[5,[6,4,5]], [-1,[0,-2,-1]]]) {
  const f = projectionFixture([50,1,3], { selectedLane, browsingRow: 61, mode: 'filled' });
  const labels = f.labels();
  assert.deepEqual(labels.map(label=>label.selected), [false,false,true]);
  for (const label of labels) f.assertAnchor(label, physicalLanes[label.lane], 61,
    'Filled mode retains the nearest repeated column and its active row in both directions');
}
{
  const f = projectionFixture([1]);
  f.host.loaded = false;
  assert.deepEqual(f.labels(), [], 'An unloaded scene must not expose stale labels');
  setMusicAlbums([], []);
  f.host.loaded = true;
  assert.deepEqual(productionMethods().getOverviewColumns.call(f.host), [], 'An empty library must have no labels');
}
// Full overview centers each column's geometric midpoint. Odd counts align
// their middle album and even counts straddle that same line with the middle pair.
const centeredCounts = [1, 2, 3, 4, 49, 100];
for (const browsingRow of [10, 12, 18.25, 61, 111]) {
  const f = projectionFixture(centeredCounts, { selectedLane: 2, browsingRow, overview: 1 });
  const labels = f.labels();
  assert.equal(labels.length, centeredCounts.length);
  for (const [lane, count] of centeredCounts.entries()) {
    const midpoint = 12 + (count - 1) / 2;
    const offset = f.host.musicColumnRowOffset(lane);
    assert.ok(Math.abs(midpoint + offset - browsingRow) < 1e-10, 'Every column shares the same visual center');
    if (count % 2) {
      assert.ok(Number.isInteger(midpoint), 'Odd columns align an actual middle album');
    } else {
      const lower = Math.floor(midpoint) + offset - browsingRow;
      const upper = Math.ceil(midpoint) + offset - browsingRow;
      assert.ok(Math.abs(lower + .5) < 1e-10 && Math.abs(upper - .5) < 1e-10,
        'Even columns place their middle albums half a row either side of the center');
    }
    f.assertAnchor(labels.find(label => label.lane === lane), lane, midpoint,
      'Overview labels follow the shared center for both odd and even counts');
  }
}

// Test the production pool mapping throughout the transition, including long
// columns whose middle albums lie beyond the original display window.
for (const browsingRow of [10, 12, 18.25, 61, 111]) {
  for (const overview of [0, .2, .5, .9, 1]) {
    const f = projectionFixture(centeredCounts, { selectedLane: 2, browsingRow, overview });
    const center = { lane: 2, row: browsingRow };
    const cells = Array.from({ length: LOOP_COLUMNS * MUSIC_LOOP_ROWS }, (_, index) => f.host.visibleMusicCell(index, center));
    const actual = cells.filter(cell => isRealAlbumCell(cell.lane, cell.row, centeredCounts));
    const identities = actual.map(cell => `${cell.lane}:${cell.row}`);
    assert.equal(new Set(identities).size, identities.length, 'Moving each column window must never duplicate an album');
    for (const [lane, count] of centeredCounts.entries()) {
      const midpoint = 12 + (count - 1) / 2;
      const activeRow = f.host.selectedCell.row;
      const expectedCenter = lane === 2 ? activeRow * (1 - overview) + midpoint * overview : midpoint;
      const expectedOffset = browsingRow - expectedCenter;
      assert.ok(Math.abs(f.host.musicColumnRowOffset(lane) - expectedOffset) < 1e-10,
        'Inactive columns cancel the global rail throughout the overview transition');
      const rows = cells.filter(cell => cell.lane === lane).map(cell => cell.row).sort((a, b) => a - b);
      assert.equal(rows.length, MUSIC_LOOP_ROWS);
      assert.equal(rows.at(-1) - rows[0], MUSIC_LOOP_ROWS - 1, 'A column window stays contiguous');
      const windowCenter = browsingRow - expectedOffset;
      for (const row of rows) {
        assert.ok(Number.isInteger(row), 'Visual shifts retain integer logical album identities');
        assert.ok(row - windowCenter >= -MUSIC_LOOP_ROWS / 2 - 1e-10 &&
          row - windowCenter < MUSIC_LOOP_ROWS / 2 + 1e-10, 'The render pool follows the shifted column center');
      }
      if (overview === 1 || lane !== 2) assert.equal(actual.filter(cell => cell.lane === lane).length, Math.min(count, MUSIC_LOOP_ROWS),
        'Centered inactive columns show every album up to the finite pool capacity, also in close view');
    }
    if (overview === 0) for (const lane of [0, 1, 3, 4, 5]) {
      const midpoint = 12 + (centeredCounts[lane] - 1) / 2;
      assert.ok(Math.abs(f.host.musicRealColumns.row(lane) - midpoint) < 1e-10,
        'Returning to close view keeps every inactive column centered');
    }
  }
}

for (const overview of [0, .5, 1]) {
  const f = projectionFixture([1, 2, 49, 100], { selectedLane: 2, browsingRow: 61, mode: 'filled', overview });
  const center = { lane: 2, row: 61 };
  for (let index = 0; index < LOOP_COLUMNS * MUSIC_LOOP_ROWS; index++) {
    const cell = f.host.visibleMusicCell(index, center);
    assert.deepEqual(cell, visibleCell(index, center, MUSIC_LOOP_ROWS), 'Filled arrays preserve their existing looping window');
    assert.equal(f.host.musicColumnRowOffset(cell.lane), 0, 'Filled arrays never receive a real-column shift');
  }
  for (const label of f.labels()) f.assertAnchor(label, [4, 1, 2, 3][label.lane], 61,
    'Filled labels keep their nearest repeated column and existing row at all overview progress values');
}
{
  const f = projectionFixture([1, 100], { browsingRow: 61, overview: 1 });
  Object.assign(f.host, productionMethods({ music: false }));
  assert.equal(f.host.musicColumnRowOffset(0), 0, 'Original archive arrays must not receive music overview centering');
  assert.equal(f.host.musicColumnRowOffset(1), 0);
  for (const lane of [-1, 2]) {
    assert.ok(Number.isFinite(productionMethods().musicColumnRowOffset.call(f.host, lane)),
      'Missing physical columns retain finite pool coordinates');
    assert.equal(isRealAlbumCell(lane, 12, [1, 100]), false, 'Missing physical columns stay masked');
  }
}
console.log('Overview: camera convergence at 20/30/60/120 fps, responsive labels, exact real-column counts/no duplicates, production projection for unequal real columns and filled loops, independent close-view centering, odd/even midpoints, moving column pool windows, viewport culling, unloaded/empty state passed.');
