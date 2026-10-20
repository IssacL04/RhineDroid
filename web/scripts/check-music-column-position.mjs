import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { setMusicAlbums, records, archiveColumns, columnFiles, fileLocation } from '../src/data.ts';
import { fileAtCell, nearestOccurrence, selectionCell, wrap } from '../src/archive-loop.ts';
import { normalizeMusicArrayMode } from '../src/music-array-layout.ts';

// Execute the production preference, change handler and navigation functions.
// Only browser storage, presentation/scene ports and markup dependencies are mocked.
const source = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('music-app.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const transpile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const variable = name => {
  const node = tree.statements.find(node => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(declaration => declaration.name.getText(tree) === name));
  assert.ok(node, `Production variable ${name} exists`); return node.getText(tree);
};
const functionSource = name => {
  const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, `Production function ${name} exists`); return node.getText(tree);
};
function eventBranch(event, condition) {
  const listener = tree.statements.find(node => ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) && node.expression.expression.getText(tree) === 'document.addEventListener' &&
    node.expression.arguments[0]?.text === event);
  assert.ok(listener, `Production ${event} listener exists`);
  const body = listener.expression.arguments[1].body;
  const branch = body.statements.find(node => ts.isIfStatement(node) && node.expression.getText(tree) === condition);
  assert.ok(branch, `Production ${condition} branch exists`); return branch.getText(tree);
}
const normalize = tree.statements.find(node => ts.isExpressionStatement(node) &&
  ts.isBinaryExpression(node.expression) && node.expression.left.getText(tree) === 'preferences.rememberColumnPosition');
assert.ok(normalize, 'Loaded column-position preference is normalized');
const settings = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'renderSettingsPanel');
const settingsMarkup = settings.body.statements[0].getText(tree);

const groups = [6, 3, 1].map((count, lane) => ({ id: `genre-${lane}`, name: `Column ${lane}`, count }));
setMusicAlbums(groups.flatMap(group => Array.from({ length: group.count }, (_, index) => ({
  id: `${group.id}-album-${index}`, title: `Album ${index}`, artist: group.name, genreId: group.id,
  rawGenres: [], folder: '', tracks: [], producers: [], offline: false,
}))), groups, 'genre');

function fixture(saved) {
  const storage = new Map(saved === undefined ? [] : [['rhinedroid-preferences', JSON.stringify(saved)]]);
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const calls = { select: [], scene: [], effect: [], cancelReveal: 0, collapse: 0, overview: [], cells: [] };
  const scene = { musicBrowseRow: 31.2,
    columnRows: new Map(),
    musicBrowseRowForColumn(lane) { return this.columnRows.get(lane) ?? this.musicBrowseRow; },
    setMusicArrayMode() {},
    select: (...args) => calls.scene.push(args), switchMusicAlbum: (...args) => calls.scene.push(args),
    musicColumnCell(lane, row) { calls.cells.push([lane, row]); return { lane: lane + 6, row }; },
  };
  const buttons = ['prev', 'next', 'prev', 'next'].map(action => ({ dataset: { action }, disabled: false }));
  const stage = { dataset: {}, querySelectorAll: () => buttons };
  const code = `
    ${variable('read')}
    ${variable('save')}
    ${variable('preferences')}
    ${normalize.getText(tree)}
    let selected = 0, libraryRebuilding = false, libraryIntent;
    const ready = true, boot = { active: false }, columnMemory = new Map();
    const presentation = { openingOrDetail: false, pendingSelection: undefined, queue: false,
      back() { this.pendingSelection = undefined; },
      select(request, openAfter) {
        calls.select.push({ ...request, openAfter });
        if (this.queue) this.pendingSelection = request;
      } };
    const overviewUI = { collapse: () => calls.collapse++, canEnter: () => true };
    const setOverview = value => calls.overview.push(value);
    const cancelTrackReveal = () => calls.cancelReveal++;
    const updateSelection = () => syncAlbumNavigation(), effects = { play: value => calls.effect.push(value) };
    ${['savePrefs', 'commitSelection', 'select', 'navigationSelection', 'syncAlbumNavigation', 'resolveColumnSelection', 'stepAlbum', 'stepGenre', 'setMode'].map(functionSource).join('\n')}
    function change(checked) {
      const el = { id: 'remember-column-position', checked };
      ${eventBranch('change', 'el.id === "remember-column-position"')}
    }
    function enter(lane) {
      const target = { dataset: { overviewEnterLane: String(lane) } };
      ${eventBranch('click', 'target.dataset.overviewEnterLane !== undefined')}
    }
    function arrayMode(value) {
      const el = { id: 'music-array-mode', value };
      ${eventBranch('change', 'el.id === "music-array-mode"')}
    }
    function markup() {
      const DEFAULT_LIGHTING_PRESET={strength:1.3,width:1.35,offset:.3,fill:1,transitionDuration:1.1};
      const normalizeRowLighting=(value,fallback)=>({...fallback,...value});
      const playerState={outputDevices:[],outputDeviceId:"default"};
      const panel = { innerHTML: '' }, $ = () => panel;
      const themeNames = { day: '暖昼', night: '深夜' }, sortLabels = { genre: { name: '按流派' }, artist: { name: '按歌手' }, album: { name: '按专辑名' } };
      const nativeVulkan = false, experimentalOpticsAvailable = false, appVersion = '0.3.0';
      const esc = value => String(value);
      const audioOutputMarkup = () => '', qualityMarkup = () => '', renderQuality = {};
      ${settingsMarkup}
      return panel.innerHTML;
    }
    syncAlbumNavigation();
    return { preferences, columnMemory, presentation, change, enter, markup, arrayMode, setMode,
      commitSelection, resolveColumnSelection, stepAlbum, stepGenre, selected: () => selected,
      setRebuilding(value) { libraryRebuilding = value; libraryIntent = undefined; },
      intent: () => libraryIntent };
  `;
  const ports = new Function('localStorage', 'records', 'archiveColumns', 'columnFiles', 'fileLocation', 'fileAtCell', 'nearestOccurrence', 'wrap', 'scene', 'calls', 'stage', 'normalizeMusicArrayMode', transpile(code))(
    localStorage, records, archiveColumns, columnFiles, fileLocation, fileAtCell, nearestOccurrence, wrap, scene, calls, stage, normalizeMusicArrayMode,
  );
  return { ...ports, scene, calls, storage, buttons };
}

for (const saved of [undefined, {}, { volume: .3 }, { rememberColumnPosition: undefined },
  { rememberColumnPosition: null }, { rememberColumnPosition: 'false' }, { rememberColumnPosition: 0 }, { rememberColumnPosition: [] }]) {
  assert.equal(fixture(saved).preferences.rememberColumnPosition, true, 'Old and malformed settings keep the established default');
}
assert.equal(fixture({ rememberColumnPosition: false }).preferences.rememberColumnPosition, false);
assert.equal(fixture({ rememberColumnPosition: true }).preferences.rememberColumnPosition, true);

const f = fixture({ volume: .3 });
const first = columnFiles(0), second = columnFiles(1);
f.columnMemory.set(archiveColumns[0], records[first[1]].id);
f.columnMemory.set(archiveColumns[1], records[second[2]].id);
assert.deepEqual(f.resolveColumnSelection(1), { index: second[2] });
const initialCalls = JSON.stringify(f.calls), oldMemory = [...f.columnMemory];
f.change(false);
assert.equal(JSON.stringify(f.calls), initialCalls, 'Toggling memory does not navigate, animate or play audio');
assert.deepEqual([...f.columnMemory], oldMemory, 'Disabling leaves session memory intact');
const persisted = JSON.parse(f.storage.get('rhinedroid-preferences'));
assert.equal(persisted.rememberColumnPosition, false);
assert.equal(persisted.volume, .3, 'Persisting this preference retains unrelated choices');
assert.equal(fixture(persisted).preferences.rememberColumnPosition, false, 'The choice survives a fresh page instance');
f.commitSelection(first[5]);
assert.deepEqual([...f.columnMemory], oldMemory, 'Browsing while disabled must not write per-column memory');
const disabledCalls = JSON.stringify(f.calls);
f.change(true);
assert.equal(JSON.stringify(f.calls), disabledCalls, 'Re-enabling also leaves selection and playback alone');
assert.equal(f.columnMemory.get(archiveColumns[0]), records[first[5]].id, 'Re-enabling remembers the current album');
assert.equal(f.columnMemory.get(archiveColumns[1]), records[second[2]].id, 'Other session memories survive the toggle');
assert.equal(f.selected(), first[5]);
let markup = f.markup();
assert.match(markup, /id="remember-column-position"\s+checked/);
assert.ok(markup.indexOf('高级设置 · 专辑阵列') < markup.indexOf('id="remember-column-position"'));
f.change(false); markup = f.markup();
assert.doesNotMatch(markup.match(/<input[^>]+id="remember-column-position"[^>]*>/)[0], /\bchecked\b/);
assert.match(markup, /关闭后保持画面深度，选中邻近专辑/);
assert.match(markup, /各列独立居中；上下浏览到本列首尾时停止/);

// Filled shelves resolve the measured rendered row, even when the current
// selected target and the row of its canonical album are somewhere else.
f.scene.musicBrowseRow = 31.2;
f.scene.selectedCell = { lane: 0, row: 101 };
assert.notEqual(f.scene.musicBrowseRow, f.scene.selectedCell.row, 'The rail is still traveling toward a distant selected occurrence');
assert.notEqual(f.scene.musicBrowseRow, fileLocation(f.selected()).row, 'The rendered depth also differs from the album canonical row');
assert.deepEqual(f.resolveColumnSelection(1), { index: fileAtCell({ lane: 1, row: 31 }), row: 31 });
f.stepGenre(1);
assert.equal(f.calls.select.at(-1).navigation.row, 31);
assert.equal(f.calls.select.at(-1).index, fileAtCell({ lane: 1, row: 31 }));
f.enter(1);
assert.deepEqual(f.calls.cells.at(-1), [1, 31]);
assert.deepEqual(f.calls.select.at(-1).navigation, { cell: { lane: 7, row: 31 }, guided: true });
assert.equal(f.calls.select.at(-1).openAfter, false, 'Overview entry returns to browsing without opening details');
assert.equal(f.calls.overview.at(-1), false);
f.presentation.pendingSelection = { index: columnFiles(2)[0], navigation: { axis: 'lane', direction: 2, row: 99 } };
f.scene.musicBrowseRow = 30.7; f.stepGenre(1);
assert.deepEqual(f.calls.select.at(-1).navigation, { axis: 'lane', direction: 3, row: 31 }, 'Coalesced input preserves the latest measured row');
assert.equal(fileAtCell(selectionCell(f.calls.select.at(-1).index, f.scene.selectedCell,
  f.calls.select.at(-1).navigation)), f.calls.select.at(-1).index, 'Coalesced direction and requested album identity agree across the seam');
f.presentation.pendingSelection = undefined;
f.scene.musicBrowseRow = -2.4;
assert.deepEqual(f.resolveColumnSelection(1), { index: second[1], row: -2 }, 'Filled shelves preserve a negative physical period while wrapping album identity');
f.stepGenre(1);
assert.equal(f.calls.select.at(-1).navigation.row, -2, 'Negative occurrences survive the directional navigation port');
f.enter(1);
assert.deepEqual(f.calls.select.at(-1).navigation, { cell: { lane: 7, row: -2 }, guided: true }, 'Overview entry uses the same negative physical row and guided cadence');

// Pending requests have not reached scene.select yet. Their mixed input must
// preserve the requested column, measured depth and any explicit physical cell.
const mixed = fixture({ rememberColumnPosition: false });
mixed.commitSelection(first[5]);
mixed.scene.selectedCell = { lane: 0, row: 101 };
const checkedRequest = (message) => {
  const request = mixed.calls.select.at(-1);
  const cell = selectionCell(request.index, mixed.scene.selectedCell, request.navigation);
  assert.equal(fileAtCell(cell), request.index, `${message}: physical cell matches the requested album`);
  return { request, cell };
};
mixed.presentation.pendingSelection = { index: first[0], navigation: { axis: 'row', direction: 1 } };
mixed.stepGenre(1);
assert.deepEqual(checkedRequest('row then lane').cell, { lane: 1, row: 31 });
mixed.presentation.pendingSelection = { index: second[2] };
mixed.stepGenre(1);
assert.deepEqual(checkedRequest('direct target then lane').cell, { lane: 2, row: 31 }, 'A different pending column contributes its displacement');
mixed.presentation.pendingSelection = { index: columnFiles(2)[0] };
mixed.stepGenre(1);
assert.deepEqual(checkedRequest('direct target then forward seam').cell, { lane: 0, row: 31 }, 'The final forward step follows the nearest pending occurrence through the seam');
mixed.presentation.pendingSelection = { index: second[1], navigation: { cell: { lane: 7, row: 31 }, guided: true } };
mixed.stepGenre(1);
assert.deepEqual(checkedRequest('explicit cell then lane').cell, { lane: 8, row: 31 });
assert.equal(mixed.calls.select.at(-1).navigation.guided, true);
mixed.presentation.pendingSelection = mixed.calls.select.at(-1);
mixed.stepGenre(1);
assert.deepEqual(checkedRequest('explicit cell across seam').cell, { lane: 9, row: 31 }, 'An explicit pending period is preserved across wrap');
mixed.presentation.pendingSelection = { index: second[1], navigation: { cell: { lane: 7, row: 31 }, guided: true } };
mixed.stepAlbum(1);
assert.deepEqual(checkedRequest('explicit cell then row').cell, { lane: 7, row: 32 });
assert.equal(mixed.calls.select.at(-1).navigation.guided, true);
mixed.presentation.pendingSelection = { index: first[0] };
mixed.enter(1);
assert.deepEqual(checkedRequest('entry overrides pending target').request.navigation, { cell: { lane: 7, row: 31 }, guided: true }, 'New explicit entry and its motion intent are never discarded');
mixed.presentation.pendingSelection = undefined;
mixed.stepGenre(1);
assert.deepEqual(checkedRequest('lane-row-lane first step').cell, { lane: 1, row: 31 });
mixed.presentation.pendingSelection = mixed.calls.select.at(-1);
mixed.stepAlbum(1);
assert.deepEqual(checkedRequest('lane-row-lane middle step').cell, { lane: 1, row: 32 });
mixed.presentation.pendingSelection = mixed.calls.select.at(-1);
mixed.stepGenre(1);
assert.deepEqual(checkedRequest('lane-row-lane final step').cell, { lane: 2, row: 31 }, 'Mixed coalescing retains the accumulated column and latest displayed row');

f.preferences.arrayMode = 'realistic';
for (const [depth, row] of [[100, 14], [13.4, 13], [-100, 12]]) {
  f.scene.musicBrowseRow = depth;
  assert.deepEqual(f.resolveColumnSelection(1), { index: fileAtCell({ lane: 1, row }), row }, 'Real shelves choose the nearest existing album at the same depth');
}
f.scene.musicBrowseRow = 100;
assert.deepEqual(f.resolveColumnSelection(2), { index: columnFiles(2)[0], row: 12 }, 'A single-album shelf remains its actual first cell');
f.scene.columnRows.set(1, 13.2);
assert.deepEqual(f.resolveColumnSelection(1), { index: second[1], row: 13 }, 'Centered real shelves use the target column displayed depth, not the old global rail');
f.enter(1);
assert.deepEqual(f.calls.cells.at(-1), [1, 13], 'Overview uses the same column-relative depth resolver');
assert.deepEqual(f.resolveColumnSelection(99), { index: -1 }, 'An absent/empty column cannot produce a navigation target');
f.change(true);
f.columnMemory.set(archiveColumns[1], 'removed-album');
assert.deepEqual(f.resolveColumnSelection(1), { index: second[0] }, 'Missing memory falls back to the first current album');
f.columnMemory.set(archiveColumns[1], records[first[0]].id);
assert.deepEqual(f.resolveColumnSelection(1), { index: second[0] }, 'A stale memory from another column is never selected');

// Both the archive arrows and newly rendered detail arrows share the pending
// cursor; repeated key/wheel/touch/detail commands cannot wrap a real shelf.
const bounded = fixture({ arrayMode: 'realistic' });
const arrowState = f => f.buttons.map(button => button.disabled);
assert.deepEqual(arrowState(bounded), [true, false, true, false], 'Both previous arrows are disabled at the first album');
const noOpAtBoundary = direction => {
  const before = JSON.stringify(bounded.calls);
  const memory = [...bounded.columnMemory];
  bounded.stepAlbum(direction);
  assert.equal(JSON.stringify(bounded.calls), before, 'Boundary input neither selects nor cancels focus, moves the scene or plays effects');
  assert.deepEqual([...bounded.columnMemory], memory);
};
noOpAtBoundary(-3);
bounded.commitSelection(first[4]);
bounded.presentation.queue = true;
bounded.stepAlbum(3);
assert.equal(bounded.calls.select.at(-1).index, first[5]);
assert.deepEqual(bounded.calls.select.at(-1).navigation, { axis: 'row', direction: 1 }, 'A multi-album wheel event clamps and reports the effective displacement');
assert.deepEqual(arrowState(bounded), [false, true, false, true], 'Queued detail navigation disables next before its handoff commits');
noOpAtBoundary(1);
bounded.stepAlbum(-1);
assert.equal(bounded.calls.select.at(-1).index, first[4], 'Reversing a queued endpoint immediately returns toward the previous album');
assert.deepEqual(arrowState(bounded), [false, false, false, false]);
bounded.stepAlbum(100);
bounded.setMode('archive');
assert.deepEqual(arrowState(bounded), [false, false, false, false], 'Cancelling a pending detail request restores the committed album boundaries');
bounded.presentation.queue = false;
bounded.commitSelection(first[5]);
noOpAtBoundary(3);
bounded.stepAlbum(-100);
assert.equal(bounded.calls.select.at(-1).index, first[0]);
assert.equal(bounded.calls.select.at(-1).navigation.direction, -5);
bounded.commitSelection(columnFiles(2)[0]);
assert.deepEqual(arrowState(bounded), [true, true, true, true], 'A one-album column disables both directions');
noOpAtBoundary(1); noOpAtBoundary(-1);
bounded.stepGenre(1);
assert.equal(bounded.calls.select.at(-1).index, first[5], 'Artist columns still cycle horizontally and keep their memory');
bounded.commitSelection(first[0]);
bounded.setRebuilding(true);
bounded.stepAlbum(100);
assert.equal(bounded.intent().index, first[5]);
assert.deepEqual(arrowState(bounded), [false, true, false, true], 'Library rebuild intents use the same pending boundary state');
noOpAtBoundary(1);
bounded.setMode('archive');
assert.deepEqual(arrowState(bounded), [true, false, true, false]);
bounded.setRebuilding(false);
bounded.arrayMode('filled');
assert.deepEqual(arrowState(bounded), [false, false, false, false], 'Switching to filled mode immediately restores both arrows');
bounded.stepAlbum(-1);
assert.equal(bounded.calls.select.at(-1).index, first[5], 'Filled mode still wraps first to last');
assert.equal(bounded.calls.select.at(-1).navigation.direction, -1);
bounded.commitSelection(first[5]);
bounded.stepAlbum(3);
assert.equal(bounded.calls.select.at(-1).index, first[2], 'Filled multi-step browsing preserves cyclic displacement');
assert.equal(bounded.calls.select.at(-1).navigation.direction, 3);
bounded.arrayMode('realistic');
assert.deepEqual(arrowState(bounded), [false, true, false, true], 'Switching back immediately restores finite endpoints');
const css = await readFile(new URL('../src/music.css', import.meta.url), 'utf8');
assert.match(css, /\.album-stepper > button:not\(:disabled\):hover/);
assert.match(functionSource('renderDetail'), /article\.scrollTop = scroll;\s*syncAlbumNavigation\(\)/, 'Newly rebuilt detail buttons are synchronized');
setMusicAlbums([], [], 'genre');
const empty = fixture({ arrayMode: 'realistic' });
assert.deepEqual(arrowState(empty), [true, true, true, true]);
empty.stepAlbum(1);
assert.equal(empty.calls.select.length, 0);
console.log('Column-position and finite browsing: persistence, target-column depth, coalesced rows, pending/committed/rebuild boundaries, side-effect-free limits, detail arrows, empty/single columns, live mode changes and filled/horizontal loops passed.');
