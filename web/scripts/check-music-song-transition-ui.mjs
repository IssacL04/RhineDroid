import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { normalizeSongTransition } from '../src/music-song-transition.ts';

const modes = ['fade-out', 'fade-in-out', 'gapless'];
for (const mode of modes) for (const legacy of [undefined, true, false, null, 'false', 0])
  assert.equal(normalizeSongTransition(mode, legacy), mode, 'An explicit new mode wins over legacy fade preferences');
for (const invalid of [undefined, null, false, true, '', 'fade', 'GAPLESS', 0, {}, [], ['gapless']]) {
  assert.equal(normalizeSongTransition(invalid, false), 'gapless');
  for (const legacy of [undefined, true, null, 'false', 0])
    assert.equal(normalizeSongTransition(invalid, legacy), 'fade-in-out');
}

// Run the production preference load, player options, settings markup and
// change branch. Browser storage and player effects are isolated from music.
const source = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('music-app.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const variable = name => {
  const node = tree.statements.find(node => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(declaration => declaration.name.getText(tree) === name));
  assert.ok(node, `Production variable ${name} exists`);
  return node.getText(tree);
};
const functionSource = name => {
  const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, `Production function ${name} exists`);
  return node.getText(tree);
};
const normalization = tree.statements.find(node => ts.isExpressionStatement(node) &&
  ts.isBinaryExpression(node.expression) && node.expression.left.getText(tree) === 'preferences.songTransition');
const retireLegacy = tree.statements.find(node => ts.isExpressionStatement(node) &&
  ts.isDeleteExpression(node.expression) && node.expression.expression.getText(tree) === 'preferences.songFade');
assert.ok(normalization && retireLegacy, 'Legacy settings are normalized before the obsolete key is retired');
assert.ok(normalization.pos < retireLegacy.pos);
const settings = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'renderSettingsPanel');
const changeListener = tree.statements.find(node => ts.isExpressionStatement(node) &&
  ts.isCallExpression(node.expression) && node.expression.expression.getText(tree) === 'document.addEventListener' &&
  node.expression.arguments[0]?.text === 'change');
const changeBranch = changeListener.expression.arguments[1].body.statements.find(node =>
  ts.isIfStatement(node) && node.expression.getText(tree) === 'el.id === "song-fade-setting"');
assert.ok(changeBranch, 'The production change branch retains the established control id');
const transpile = code => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function fixture(saved, { rawStorage, denyStorage = false, legacySaved } = {}) {
  const storage = new Map(saved === undefined ? [] : [['rhinedroid-preferences', JSON.stringify(saved)]]);
  if (legacySaved !== undefined) storage.set('rhine-music-preferences', JSON.stringify(legacySaved));
  if (rawStorage !== undefined) storage.set('rhinedroid-preferences', rawStorage);
  const localStorage = {
    getItem(key) { if (denyStorage) throw new Error('Unavailable storage'); return storage.get(key) ?? null; },
    setItem(key, value) { if (denyStorage) throw new Error('Unavailable storage'); storage.set(key, value); },
  };
  const calls = [];
  const playback = { albumId: 'album-kept', trackId: 'track-kept', playing: true, position: 87.25 };
  class MusicPlayer {
    constructor(options) { this.options = { ...options }; }
    setSongTransitionMode(mode) { calls.push({ method: 'setSongTransitionMode', mode }); }
    playTrack() { assert.fail('Changing a preference must not select or restart a track'); }
    stop() { assert.fail('Changing a preference must not stop playback'); }
  }
  const code = `
    ${variable('read')}
    ${variable('save')}
    ${variable('preferences')}
    ${normalization.getText(tree)}
    ${retireLegacy.getText(tree)}
    ${variable('player')}
    ${functionSource('savePrefs')}
    let selected = 37;
    const select = () => { throw new Error('Unexpected album selection'); };
    const setMode = () => { throw new Error('Unexpected navigation'); };
    function change(value) {
      const el = { id: 'song-fade-setting', value };
      ${changeBranch.getText(tree)}
      return el.value;
    }
    function markup() {
      const DEFAULT_LIGHTING_PRESET={strength:1.3,width:1.35,offset:.3,fill:1,transitionDuration:1.1};
      const normalizeRowLighting=(value,fallback)=>({...fallback,...value});
      const playerState={outputDevices:[],outputDeviceId:"default"};
      const panel = { innerHTML: '' }, $ = () => panel;
      const themeNames = { day: '暖昼', night: '深夜' };
      const sortLabels = { genre: { name: '按流派' }, artist: { name: '按歌手' }, album: { name: '按专辑名' } };
      const nativeVulkan = false, experimentalOpticsAvailable = false, appVersion = '0.3.0';
      const esc = value => String(value);
      const audioOutputMarkup = () => '', qualityMarkup = () => '', renderQuality = {};
      ${settings.body.statements[0].getText(tree)}
      return panel.innerHTML;
    }
    return { preferences, player, change, markup, selected: () => selected };
  `;
  const ports = new Function('localStorage', 'normalizeSongTransition', 'AndroidMusicPlayer', transpile(code))(
    localStorage, normalizeSongTransition, MusicPlayer,
  );
  return { ...ports, storage, calls, playback };
}

const optionState = markup => {
  const control = markup.match(/<select\b[^>]*\bid="song-fade-setting"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(control, 'Song transitions use a native select');
  assert.match(control[0], /aria-label="歌曲衔接方式"/);
  assert.doesNotMatch(markup, /<input\b[^>]*\bid="song-fade-setting"/);
  const options = [...control[1].matchAll(/<option\b([^>]*)>([^<]+)<\/option>/g)].map(([, attrs, label]) => ({
    value: attrs.match(/\bvalue="([^"]+)"/)[1], label, selected: /\bselected\b/.test(attrs),
  }));
  assert.deepEqual(options.map(({ value, label }) => [value, label]), [
    ['fade-out', '淡出但不淡入'], ['fade-in-out', '淡出淡入'], ['gapless', '无缝播放'],
  ]);
  assert.equal(options.filter(option => option.selected).length, 1, 'Exactly one persisted mode is selected');
  return options.find(option => option.selected).value;
};

for (const [saved, expected] of [
  [undefined, 'fade-in-out'], [{}, 'fade-in-out'], [null, 'fade-in-out'],
  [{ songFade: true }, 'fade-in-out'], [{ songFade: false }, 'gapless'],
  [{ songFade: 'false' }, 'fade-in-out'], [{ songFade: 0 }, 'fade-in-out'],
  [{ songTransition: null, songFade: false }, 'gapless'],
  [{ songTransition: 'invalid' }, 'fade-in-out'],
  [{ songTransition: 'invalid', songFade: false }, 'gapless'],
  ...modes.map(mode => [{ songTransition: mode, songFade: false }, mode]),
]) {
  const f = fixture(saved);
  assert.equal(f.preferences.songTransition, expected);
  assert.equal(f.player.options.songTransitionMode, expected, 'Playback starts with the normalized persisted mode');
  assert.ok(!Object.hasOwn(f.preferences, 'songFade'), 'Only the new setting survives normalization');
  assert.equal(optionState(f.markup()), expected);
  assert.deepEqual(f.calls, [], 'Loading settings does not issue playback commands');
}

for (const mode of modes) {
  const f = fixture({ songFade: false, volume: .42, bgm: false, bgmVolume: .21,
    sound: false, soundVolume: .18, rememberColumnPosition: false });
  const originalPlayback = { ...f.playback }, originalSelection = f.selected();
  assert.equal(f.change(mode), mode);
  assert.equal(f.preferences.songTransition, mode);
  assert.deepEqual(f.calls, [{ method: 'setSongTransitionMode', mode }]);
  assert.equal(f.selected(), originalSelection);
  assert.deepEqual(f.playback, originalPlayback);
  const persisted = JSON.parse(f.storage.get('rhinedroid-preferences'));
  assert.equal(persisted.songTransition, mode);
  assert.ok(!Object.hasOwn(persisted, 'songFade'), 'Saving removes the retired legacy boolean');
  for (const key of ['volume', 'bgm', 'bgmVolume', 'sound', 'soundVolume', 'rememberColumnPosition'])
    assert.equal(persisted[key], f.preferences[key], `Saving preserves ${key}`);
  const reloaded = fixture(persisted);
  assert.equal(reloaded.preferences.songTransition, mode);
  assert.equal(reloaded.player.options.songTransitionMode, mode);
  assert.equal(optionState(reloaded.markup()), mode);
}

const legacyBrand = fixture(undefined, { legacySaved: { songFade: false, volume: .37, rememberColumnPosition: false } });
assert.equal(legacyBrand.preferences.songTransition, 'gapless', 'Renaming preserves existing browser preferences');
assert.equal(legacyBrand.preferences.volume, .37);
assert.equal(legacyBrand.preferences.rememberColumnPosition, false);
legacyBrand.change('fade-out');
assert.equal(JSON.parse(legacyBrand.storage.get('rhinedroid-preferences')).songTransition, 'fade-out', 'New writes use the RhineDroid key');
const currentBrand = fixture({ songTransition: 'fade-in-out', volume: .8 }, { legacySaved: { songFade: false, volume: .37 } });
assert.equal(currentBrand.preferences.songTransition, 'fade-in-out', 'Current preferences take precedence over the legacy name');
assert.equal(currentBrand.preferences.volume, .8);

const malformed = fixture(undefined, { rawStorage: '{broken' });
assert.equal(malformed.preferences.songTransition, 'fade-in-out');
assert.equal(malformed.change('invalid'), 'fade-in-out');
assert.equal(optionState(malformed.markup()), 'fade-in-out');
const unavailable = fixture(undefined, { denyStorage: true });
assert.equal(unavailable.preferences.songTransition, 'fade-in-out');
assert.doesNotThrow(() => unavailable.change('fade-out'), 'Unavailable storage does not block a live settings change');
assert.equal(unavailable.preferences.songTransition, 'fade-out');

console.log('Song-transition UI passed: ordered three-mode select, defaults, legacy migration, persisted enum precedence, startup player options, isolated settings changes and storage failures.');
