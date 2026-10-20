// Run the production frame/lifecycle functions in isolation. Counters replace
// the DOM/GPU/audio; this verifies control flow, not real GPU frame rate.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { MusicFrameTiming } from '../src/music-frame-timing.ts';
import './check-music-frame-timing.mjs';

const { version: appVersion } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const source = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('music-app.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const functionNames = ['frame', 'resetFrameTiming', 'suspendPage', 'resumePage', 'disposePage'];
const declarationNames = ['lastFrame', 'frameCount', 'frameDisposed', 'frameTiming', 'textMotionTime'];
const functions = functionNames.map(name => {
  const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, `Production ${name} must exist`);
  return node.getText(tree);
}).join('\n');
function productionFunction(name) {
  const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, `Production ${name} must exist`);
  return ts.transpileModule(node.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
const declarations = tree.statements.filter(node => ts.isVariableStatement(node) &&
  node.declarationList.declarations.some(declaration => declarationNames.includes(declaration.name.getText(tree))))
  .map(node => node.getText(tree)).join('\n');
const listeners = tree.statements.filter(node => ts.isExpressionStatement(node) &&
  ts.isCallExpression(node.expression) && node.expression.arguments[0] &&
  ts.isStringLiteral(node.expression.arguments[0]) &&
  ['visibilitychange', 'pagehide', 'pageshow'].includes(node.expression.arguments[0].text))
  .map(node => node.getText(tree)).join('\n');
assert.equal(listeners.match(/addEventListener/g)?.length, 3, 'All production lifecycle listeners are included');
const compiledCode = ts.transpileModule(`${declarations}\n${functions}\n${listeners}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function eventTarget() {
  const listeners = new Map();
  return { addEventListener(type, callback) {
    const callbacks = listeners.get(type) || [];
    callbacks.push(callback);
    listeners.set(type, callbacks);
  }, dispatch(type, event = {}) { for (const callback of listeners.get(type) || []) callback(event); } };
}
function fixture({ renderScene = true, firstMs = 0, reduced = false, speed = 1, ready = true } = {}) {
  const pending = new Map(), elements = new Map();
  const calls = { scene: 0, boot: 0, viewer: 0, presentation: 0, library: 0, clearTimeout: [],
    decryption: [], dispose: { scene: 0, boot: 0, overview: 0, player: 0, effects: 0, trackFocus: 0 } };
  const document = { ...eventTarget(), hidden: false, querySelector: () => null }, window = eventTarget();
  const scene = { update: () => calls.scene++, musicPresentationPhase: 'archive',
    getStats: () => ({ drawCalls: 12, triangles: 1000 }), dispose: () => calls.dispose.scene++ };
  const boot = { active: true, result: { renderScene, cinema: { time: 21.92 } },
    update: () => { calls.boot++; return boot.result; }, dispose: () => calls.dispose.boot++ };
  const viewer = { isOpen: false, update: () => calls.viewer++ };
  const presentation = { phase: 'archive', update: () => calls.presentation++ };
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, { dataset: {}, textContent: '' });
    return elements.get(selector);
  };
  let handle = 0, cpuClock = 0;
  const requestAnimationFrame = callback => { const id = ++handle; pending.set(id, callback); return id; };
  const cancelAnimationFrame = id => pending.delete(id);
  const compiled = new Function('document', 'window', 'scene', 'boot', 'viewer', 'presentation', '$',
    'requestAnimationFrame', 'cancelAnimationFrame', 'MusicFrameTiming', 'config', 'calls', 'appVersion', `
    const performance = { now: () => config.cpuNow() };
    const nativeVulkan = false;
    const nowPlayingTransition = { dispose() {} }, fitFrame = 0;
    const preferences = { reduced: config.reduced, theme: 'day' }, themeNames = { day: '暖昼' };
    const stage = { dataset: {} }, getMusicMotionSpeed = () => config.speed;
    const updateOverview = () => {}, overviewRevealPending = false, overview = false;
    const overviewUI = { dispose: () => calls.dispose.overview++ };
    const showBrowseSurface = () => {}, documentDecryption = { update: time => calls.decryption.push(time) };
    const pendingDetailFocus = false, pendingTrackReveal = undefined, panel = undefined;
    const pollTimer = 17, toastTimer = 18, clearTimeout = id => calls.clearTimeout.push(id);
    const loadLibrary = () => { calls.library++; };
    const player = { dispose: () => calls.dispose.player++ };
    const effects = { suspend() {}, resume() {}, dispose: () => calls.dispose.effects++ };
    const trackFocus = { cancel: () => calls.dispose.trackFocus++ };
    let ready = config.ready;
    ${compiledCode}
    return { frame, suspendPage, resumePage, disposePage, setReady: value => { ready = value; },
      state: () => ({ lastFrame, frameCount, frameHandle, frameDisposed, frameSuspended,
        textMotionTime, textMotionLastFrame, timing: frameTiming.snapshot() }) };
  `)(document, window, scene, boot, viewer, presentation, $, requestAnimationFrame, cancelAnimationFrame,
    MusicFrameTiming, { reduced, speed, ready, cpuNow: () => { cpuClock += 2; return cpuClock; } }, calls, appVersion);
  const result = { ...compiled, calls, pending, elements, document, window, boot, viewer, presentation,
    next(ms) {
      assert.equal(pending.size, 1, 'Exactly one main frame continuation, without accumulation');
      const [id, callback] = pending.entries().next().value;
      pending.delete(id);
      callback(ms);
    } };
  compiled.resumePage();
  if (ready) result.next(firstMs);
  return result;
}

const steady = fixture({ firstMs: 30000 });
assert.equal(steady.elements.get('#runtime-info')?.textContent, undefined, 'No misleading 0 FPS is emitted for the 30 s load');
assert.equal(steady.state().timing.samples, 0);
for (let index = 1; index <= 600; index++) steady.next(30000 + index * 1000 / 60);
assert.equal(steady.calls.scene, 601);
assert.equal(steady.pending.size, 1);
assert.equal(steady.state().timing.samples, 240);
assert.equal(steady.state().timing.fps, 60);
assert.equal(steady.state().timing.cpuP95, 2);
assert.match(steady.elements.get('#runtime-info').textContent, /^6[01] FPS \/ 暖昼 \/ V/);
assert.ok(steady.elements.get('#runtime-info').textContent.endsWith(` / V${appVersion}`));
assert.equal(JSON.parse(steady.elements.get('#three-scene').dataset.frameTiming).fps, 60);

const opaque = fixture({ renderScene: false });
for (let index = 1; index <= 600; index++) opaque.next(index * 1000 / 60);
assert.equal(opaque.calls.scene, 0, 'The opaque 2D opening never submits the main scene');
assert.equal(opaque.calls.boot, 601, 'The opening clock continues behind the scene gate');
opaque.boot.result.renderScene = true;
opaque.next(601 * 1000 / 60);
assert.equal(opaque.calls.scene, 1, 'The first visible shelf frame is rendered immediately');
opaque.boot.active = false;
opaque.boot.result = undefined;
for (let index = 602; index <= 901; index++) opaque.next(index * 1000 / 60);
assert.equal(opaque.calls.scene, 301, 'An inactive/no-opening state does not suppress the scene');
assert.equal(opaque.calls.presentation, 300);
opaque.viewer.isOpen = true;
opaque.next(902 * 1000 / 60);
assert.equal(opaque.calls.scene, 301, 'The other viewer retains exclusive rendering');

const hidden = fixture();
hidden.next(1000 / 60);
const beforeHidden = hidden.state().textMotionTime, beforeHiddenScene = hidden.calls.scene;
hidden.document.hidden = true;
hidden.next(1000 / 30); // Covers the visibility-event race/fallback branch.
assert.equal(hidden.calls.scene, beforeHiddenScene);
assert.equal(hidden.state().textMotionLastFrame, undefined);
assert.equal(hidden.state().timing.samples, 0);
hidden.document.dispatch('visibilitychange');
assert.equal(hidden.pending.size, 0, 'A hidden page cancels its main RAF instead of polling');
assert.equal(hidden.state().frameSuspended, true);
assert.ok(hidden.calls.clearTimeout.includes(17), 'Visibility suspension clears the library timer');
hidden.document.hidden = false;
hidden.document.dispatch('visibilitychange');
hidden.next(300033.3333333333);
assert.equal(hidden.state().textMotionTime, beforeHidden, 'The first resumed frame consumes none of the hidden 300 s');
assert.equal(hidden.state().timing.samples, 0);
hidden.next(300050);
assert.ok(Math.abs(hidden.state().textMotionTime - beforeHidden - 1 / 60) < 1e-9);
for (let index = 1; index <= 300; index++) {
  hidden.document.dispatch('visibilitychange');
  hidden.window.dispatch('pageshow', { persisted: true });
  assert.equal(hidden.pending.size, 1, 'Repeated visibility/BFCache resume signals cannot add another RAF');
  hidden.next(300050 + index * 1000 / 60);
}

const bounded = fixture({ speed: 3 });
bounded.presentation.phase = 'detail';
bounded.next(300000);
assert.ok(Math.abs(bounded.state().textMotionTime - .15) < 1e-9, 'A visible stall contributes at most 50 ms, with speed applied once');
assert.equal(bounded.calls.decryption.length, 1);
const reduced = fixture({ speed: 3, reduced: true });
reduced.next(300000);
assert.equal(reduced.state().textMotionTime, .05, 'Reduced motion does not multiply the text clock');

const cache = fixture();
cache.window.dispatch('pagehide', { persisted: true });
assert.equal(cache.pending.size, 0);
assert.equal(cache.calls.dispose.scene, 0, 'BFCache suspension preserves the renderer');
cache.window.dispatch('pageshow', { persisted: true });
assert.equal(cache.pending.size, 1);
cache.next(900000);
assert.equal(cache.state().textMotionTime, 0);
const lateCallback = cache.pending.values().next().value;
cache.window.dispatch('pagehide', { persisted: false });
assert.equal(cache.pending.size, 0);
assert.equal(cache.state().frameDisposed, true);
cache.disposePage();
cache.resumePage();
cache.window.dispatch('pageshow', { persisted: true });
lateCallback(900050);
assert.equal(cache.pending.size, 0, 'A stale callback cannot resurrect a disposed frame loop');
assert.deepEqual(cache.calls.dispose, { scene: 1, boot: 1, overview: 1, player: 1, effects: 1, trackFocus: 1 }, 'Repeated disposal releases each resource exactly once');

const loading = fixture({ ready: false });
loading.resumePage();
assert.equal(loading.pending.size, 0, 'A visibility event cannot render before scene preparation finishes');
loading.setReady(true);
loading.resumePage();
loading.resumePage();
assert.equal(loading.pending.size, 1);
loading.next(50000);
assert.equal(loading.calls.scene, 1);

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function startupFixture({ waitAt, native = false, hidden = false } = {}) {
  const gate = deferred(), reached = deferred(), pending = new Map(), calls = [];
  const wait = async stage => {
    calls.push(stage);
    if (stage === waitAt) { reached.resolve(); await gate.promise; }
  };
  const elements = new Map();
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, { dataset: {}, setAttribute() {}, remove() { calls.push('remove-loading'); } });
    return elements.get(selector);
  };
  const compiled = new Function('wait', 'calls', 'pending', '$', 'native', 'hidden', `
    const navigator = {}, document = { hidden, fonts: { load: async () => {} } };
    const nativeVulkan = false;
    const preferences = { arrayMode: 'realistic', theme: 'day', reduced: false, audioBackend: native ? 'coreaudio' : 'browser' };
    const lightingLab = false, location = { search: '' }, selected = 7, sortLabel = { column: '歌手' }, renderQuality = 1;
    const stage = { dataset: {}, classList: { toggle() {}, add() {} } };
    let frameDisposed = false, frameSuspended = false, frameHandle = 0, scene, ready = false, nativeLibraryPending = false;
    const loadLibrary = force => wait(force ? 'library' : 'resume-library'), refreshAudioOutputs = () => wait('audio');
    const sceneCanvasLifecycle = () => {}, restoreAndroidSelection = () => {};
    const effects = { setScene() {} }, showBrowseSurface = () => {};
    const DEFAULT_LIGHTING_PRESET = {}, normalizeRowLighting = value => value;
    const fit = () => {}, updateSelection = () => {}, syncSelectionMotion = () => {}, resetFrameTiming = () => {};
    const performance = { now: () => 6000 }, boot = { start: () => calls.push('boot-start') };
    const albums = [{ id: 'sample' }], stepAlbum = () => {}, mountMusicWheelNavigation = () => {};
    const requestAnimationFrame = callback => { pending.set(1, callback); return 1; }, frame = () => {};
    class ArchiveScene {
      constructor() { calls.push('construct-scene'); }
      setMusicArrayMode() {} enableSelectionLighting() {} setTheme() {} setReduced() {} setLightingExperiment() {}
      setQuality() { calls.push('configure-scene'); }
      async load(url, selection) { if (url !== undefined || selection !== 7) throw new Error('Selection must reach the single initial load'); await wait('model'); }
      prepareMusicRenderer() { return wait('prepare'); }
      showMusicArchiveImmediately() { calls.push('show-archive'); }
    }
    class NativeArchiveScene {}
    const createArchiveScene = async container => new ArchiveScene(container);
    ${productionFunction('start')}
    return { start, dispose: () => { frameDisposed = true; }, state: () => ({ ready, frameHandle }) };
  `)(wait, calls, pending, $, native, hidden);
  return { ...compiled, gate, reached, pending, calls };
}
for (const waitAt of ['library', 'model', 'prepare']) {
  const startup = startupFixture({ waitAt });
  const starting = startup.start();
  await startup.reached.promise;
  const callsBefore = [...startup.calls];
  startup.dispose();
  startup.gate.resolve();
  await starting;
  assert.deepEqual(startup.calls, callsBefore, `Disposal during ${waitAt} prevents every later startup stage`);
  assert.equal(startup.state().ready, false);
  assert.equal(startup.pending.size, 0);
}
const browserStartup = startupFixture();
await browserStartup.start();
assert.deepEqual(browserStartup.calls, ['library', 'construct-scene', 'model', 'configure-scene', 'prepare', 'remove-loading', 'boot-start', 'resume-library'],
  'Android UI prepares a fixed local snapshot and graphics before the prologue without initializing audio');
assert.equal(browserStartup.pending.size, 1);
const backgroundStartup = startupFixture({ hidden: true });
await backgroundStartup.start();
assert.equal(backgroundStartup.pending.size, 0, 'A startup completed in the background waits for visibility before scheduling the main RAF');
assert.ok(!backgroundStartup.calls.includes('resume-library'), 'A startup completed in the background leaves frame resumption to resumePage');


function localLibraryFixture() {
  const calls = [];
  const fixture = new Function('calls', `
    let frameDisposed = false, libraryReceived = false;
    const androidDemoLibrary = { albums: [{ id: 'local-fixture' }] };
    const receiveLibrary = async (data, force) => {
      calls.push([data.albums[0].id, force]); libraryReceived = true;
    };
    const nativeAvailable = () => false;
    const fetch = () => { throw new Error('Unexpected network'); };
    const setTimeout = () => { throw new Error('Unexpected poll'); };
    ${productionFunction('loadLibrary')}
    return { loadLibrary, dispose() { frameDisposed = true; } };
  `)(calls);
  return { ...fixture, calls };
}
const local = localLibraryFixture();
await local.loadLibrary(true);
await local.loadLibrary();
assert.deepEqual(local.calls, [['local-fixture', true]], 'Resuming uses the already established local snapshot');
local.dispose();
await local.loadLibrary(true);
assert.equal(local.calls.length, 1, 'A disposed page cannot reload data');
console.log('Android startup passed: fixed offline library, no polling/audio, staged graphics readiness, disposal and 300 frame-resume cycles.');

const lostGraphics = fixture();
lostGraphics.suspendPage();
lostGraphics.document.querySelector = () => ({});
lostGraphics.resumePage();
assert.equal(lostGraphics.pending.size, 0, 'Renderer recovery screen blocks RAF resumption');
