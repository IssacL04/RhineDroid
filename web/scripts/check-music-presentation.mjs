import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Run the production controller without a DOM/WebGL dependency. Transpilation
// also supports its TypeScript parameter properties on Node's strip-only builds.
const moduleUrls = new Map();
async function transpiledModuleUrl(url) {
  if (moduleUrls.has(url.href)) return moduleUrls.get(url.href);
  const source = await readFile(url, 'utf8');
  let { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  // A data URL has no base for relative imports. Compile local dependencies
  // recursively and share each URL so singleton settings keep one state.
  const imports = [...outputText.matchAll(/from\s+["'](\.[^"']+)["']/g)];
  for (const [, specifier] of imports) {
    const path = specifier.endsWith('.ts') ? specifier : `${specifier}.ts`;
    const dependency = await transpiledModuleUrl(new URL(path, url));
    outputText = outputText.replaceAll(`"${specifier}"`, JSON.stringify(dependency))
      .replaceAll(`'${specifier}'`, JSON.stringify(dependency));
  }
  const result = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
  moduleUrls.set(url.href, result);
  return result;
}
const { MusicPresentation } = await import(await transpiledModuleUrl(new URL('../src/music-presentation.ts', import.meta.url)));

function fixture({ reduced = false } = {}) {
  const events = [];
  const menuExits = [];
  const browseExits = [];
  const ready = { presentation: false, archive: true };
  const ports = {
    presentationReady: () => ready.presentation,
    archiveReady: () => ready.archive,
    enterCamera() {
      events.push('camera:enter');
      ready.archive = false;
      ready.presentation = reduced;
    },
    returnCamera() {
      events.push('camera:return');
      ready.presentation = false;
      ready.archive = reduced;
    },
    select(selection) {
      events.push({ select: structuredClone(selection) });
      ready.archive = reduced;
    },
    switchDetail(selection) {
      events.push({ switchDetail: structuredClone(selection) });
      ready.archive = false;
      ready.presentation = reduced;
    },
    prepareMenu: () => events.push('menu:prepare'),
    showMenu: () => events.push('menu:show'),
    hideMenu(done) {
      events.push('menu:hide');
      if (reduced) done();
      else menuExits.push(done);
    },
    hideBrowse(done) {
      events.push('browse:hide');
      if (reduced) done();
      else browseExits.push(done);
    },
    showBrowse: () => events.push('browse:show'),
    mode: (mode) => events.push(`mode:${mode}`),
  };
  const motion = new MusicPresentation(ports);
  const finishBrowse = () => {
    assert.ok(browseExits.length, 'A browse exit must be pending');
    browseExits.shift()();
  };
  const finishMenu = () => {
    assert.ok(menuExits.length, 'A menu exit must be pending');
    menuExits.shift()();
  };
  const openDetail = () => {
    motion.open();
    if (!reduced) finishBrowse();
    ready.presentation = true;
    motion.update();
    assert.equal(motion.phase, 'detail');
  };
  const selections = () => events.filter((event) => typeof event === 'object' && 'select' in event).map((event) => event.select);
  const detailSelections = () => events.filter((event) => typeof event === 'object' && 'switchDetail' in event).map((event) => event.switchDetail);
  return { motion, events, ready, ports, finishBrowse, finishMenu, openDetail, selections, detailSelections, browseExits, menuExits };
}

test('menu waits for both browse exit and completed elevated camera presentation', () => {
  const f = fixture();
  f.motion.open();
  assert.equal(f.motion.phase, 'opening');
  assert.ok(!f.events.includes('camera:enter'), 'Text must finish retiring before the physical extraction');
  assert.equal(f.events.filter((event) => event === 'menu:show').length, 0);
  // A camera readiness signal by itself may not expose an overlapping menu.
  f.ready.presentation = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'opening');
  f.ready.presentation = false;
  f.finishBrowse();
  assert.equal(f.events.at(-1), 'camera:enter');
  for (let frame = 0; frame < 120; frame++) f.motion.update();
  assert.equal(f.motion.phase, 'opening', 'Elapsed frames cannot replace camera readiness');
  assert.ok(!f.events.includes('menu:show'));
  f.ready.presentation = true;
  f.motion.update();
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
  assert.equal(f.events.filter((event) => event === 'menu:show').length, 1);
});

test('detail switch waits for menu exit and new presentation without returning to the archive', () => {
  const f = fixture();
  f.openDetail();
  f.events.length = 0;
  f.motion.select({ index: 4 }, true);
  assert.equal(f.motion.phase, 'switch-hiding');
  f.ready.presentation = true; // Even a stale ready flag cannot bypass the menu exit.
  f.motion.update();
  assert.deepEqual(f.events, ['menu:hide']);
  f.finishMenu();
  assert.deepEqual(f.events, ['menu:hide', { switchDetail: { index: 4 } }, 'menu:prepare']);
  assert.equal(f.motion.phase, 'switching');
  assert.equal(f.motion.openingOrDetail, true);
  f.motion.update();
  assert.equal(f.motion.phase, 'switching', 'Wait for the new camera/album presentation');
  assert.ok(!f.events.includes('menu:show'));
  f.ready.presentation = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
  assert.equal(f.events.at(-1), 'menu:show');
  assert.deepEqual(f.selections(), [], 'Archive selection must not interrupt the detail camera');
  assert.ok(!f.events.some((event) => ['mode:archive', 'camera:return', 'camera:enter', 'browse:hide', 'browse:show'].includes(event)));
});

for (const startingPhase of ['detail', 'opening', 'switch-hiding', 'switching']) {
  test(`search from ${startingPhase} returns to the archive, settles its selection, then reopens`, () => {
    const f = fixture();
    if (startingPhase === 'opening') { f.motion.open(); f.finishBrowse(); }
    else f.openDetail();
    if (startingPhase === 'switch-hiding' || startingPhase === 'switching') {
      f.motion.select({ index: 1 }, true);
      if (startingPhase === 'switching') f.finishMenu();
    }
    f.events.length = 0;
    const target = { index: 8, route: 'archive' };
    f.motion.select(target, true);
    assert.equal(f.menuExits.length, 1, 'Reuse an existing text exit rather than starting a second one');
    f.ready.presentation = true;
    f.motion.update();
    assert.deepEqual(f.detailSelections(), [], 'Search must not use the accelerated detail rail');
    assert.deepEqual(f.selections(), [], 'Keep the target pending while text leaves');
    f.finishMenu();
    assert.equal(f.motion.phase, 'returning');
    assert.ok(f.events.includes('camera:return'));
    f.ports.archiveInteractive = () => true;
    f.motion.update();
    assert.deepEqual(f.selections(), [], 'Search must wait for full archive readiness, not just interactivity');
    f.ready.archive = true;
    f.motion.update();
    assert.equal(f.motion.phase, 'selecting');
    assert.deepEqual(f.selections(), [target]);
    f.motion.update();
    assert.equal(f.motion.phase, 'selecting', 'Do not open before the new row and lane settle');
    f.ready.archive = true;
    f.motion.update();
    assert.equal(f.motion.phase, 'opening');
    assert.equal(f.events.filter((event) => event === 'camera:enter').length, 0);
    f.finishBrowse();
    assert.equal(f.events.filter((event) => event === 'camera:enter').length, 1);
    f.ready.presentation = true;
    f.motion.update();
    assert.equal(f.motion.phase, 'detail');
    assert.deepEqual(f.detailSelections(), []);
    assert.equal(f.events.at(-1), 'menu:show');
  });
}

test('search replacements during exit, return and row movement preserve the latest destination', () => {
  const f = fixture();
  f.openDetail();
  f.events.length = 0;
  f.motion.select({ index: 2, route: 'archive' }, true);
  f.motion.select({ index: 3, route: 'archive' }, true);
  assert.equal(f.menuExits.length, 1);
  f.finishMenu();
  const duringReturn = { index: 4, route: 'archive' };
  f.motion.select(duringReturn, true);
  f.ready.archive = true;
  f.motion.update();
  const duringSelection = { index: 6, route: 'archive' };
  f.motion.select(duringSelection, true);
  f.ready.archive = true;
  f.motion.update();
  assert.deepEqual(f.selections(), [duringReturn, duringSelection]);
  assert.deepEqual(f.detailSelections(), []);
  assert.ok(!f.events.includes('camera:enter'), 'Do not briefly open an obsolete search destination');
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'opening');
  assert.equal(f.events.filter((event) => event === 'camera:return').length, 1);
  f.finishBrowse();
  assert.equal(f.events.filter((event) => event === 'camera:enter').length, 1);
});

for (const cancelPhase of ['hiding', 'returning', 'selecting']) {
  test(`back during search ${cancelPhase} cancels reopening`, () => {
    const f = fixture();
    f.openDetail();
    f.events.length = 0;
    f.motion.select({ index: 5, route: 'archive' }, true);
    if (cancelPhase !== 'hiding') f.finishMenu();
    if (cancelPhase === 'selecting') {
      f.ready.archive = true;
      f.motion.update();
    }
    assert.equal(f.motion.phase, cancelPhase);
    f.motion.back();
    if (cancelPhase === 'hiding') f.finishMenu();
    f.ready.archive = true;
    f.motion.update();
    assert.equal(f.motion.phase, 'archive');
    assert.equal(f.motion.pendingSelection, undefined);
    assert.equal(f.motion.openingOrDetail, false);
    assert.ok(!f.events.includes('camera:enter'));
    assert.deepEqual(f.detailSelections(), []);
    assert.equal(f.selections().length, cancelPhase === 'selecting' ? 1 : 0);
  });
}

test('reduced-motion search preserves archive selection and reopen ordering', () => {
  const f = fixture({ reduced: true });
  f.openDetail();
  f.events.length = 0;
  const target = { index: 2, route: 'archive' };
  f.motion.select(target, true);
  assert.equal(f.motion.phase, 'returning');
  f.motion.update();
  assert.equal(f.motion.phase, 'selecting');
  f.motion.update();
  assert.equal(f.motion.phase, 'opening');
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
  assert.deepEqual(f.events, [
    'menu:hide', 'mode:archive', 'camera:return', { select: target },
    'mode:detail', 'menu:prepare', 'browse:hide', 'camera:enter', 'menu:show',
  ]);
});

test('rapid requests retain the latest selection and its navigation intent', () => {
  const f = fixture();
  f.openDetail();
  f.motion.select({ index: 1 }, true);
  f.motion.select({ index: 2 }, true);
  assert.equal(f.menuExits.length, 1, 'Rapid input must not restart the menu exit');
  f.finishMenu();
  assert.deepEqual(f.detailSelections(), [{ index: 2 }]);
  const final = { index: 9, navigation: { axis: 'lane', direction: -1 } };
  f.motion.select(final, true);
  assert.deepEqual(f.motion.pendingSelection, final);
  f.ready.presentation = true; // This readiness belongs to the superseded target.
  f.motion.update();
  assert.deepEqual(f.selections(), []);
  assert.deepEqual(f.detailSelections(), [{ index: 2 }, final]);
  assert.equal(f.motion.phase, 'switching');
  assert.equal(f.events.filter((event) => event === 'menu:show').length, 1, 'Do not reveal a target committed on the same frame');
  f.motion.select({ index: 10 }, true);
  f.motion.select({ index: 12 }, false);
  assert.equal(f.motion.phase, 'hiding');
  f.finishMenu();
  f.ready.archive = true;
  f.motion.update();
  assert.deepEqual(f.detailSelections(), [{ index: 2 }, final], 'A pending detail target is replaced by archive selection');
  assert.deepEqual(f.selections(), [{ index: 12 }]);
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
  assert.equal(f.events.at(-1), 'browse:show');
});

test('back during text exit cancels the pending detail switch and returns once', () => {
  const f = fixture();
  f.openDetail();
  f.motion.select({ index: 3 }, true);
  f.motion.back();
  assert.equal(f.motion.pendingSelection, undefined);
  assert.equal(f.menuExits.length, 1, 'Back must reuse the in-flight text exit');
  f.finishMenu();
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
  assert.deepEqual(f.selections(), []);
  assert.deepEqual(f.detailSelections(), []);
  assert.equal(f.events.filter((event) => event === 'camera:enter').length, 1);
  assert.equal(f.events.filter((event) => event === 'camera:return').length, 1);
});

test('latest back during a committed rail movement settles into browsing', () => {
  const f = fixture();
  f.motion.select({ index: 7 }, true);
  assert.equal(f.motion.phase, 'selecting');
  f.motion.select({ index: 8 }, true);
  f.motion.back();
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
  assert.deepEqual(f.selections(), [{ index: 7 }]);
  assert.ok(!f.events.includes('camera:enter'));
});

test('replay/reset invalidates old menu-exit callbacks', () => {
  const f = fixture();
  f.openDetail();
  f.motion.select({ index: 5 }, true);
  f.motion.reset();
  f.events.length = 0;
  f.finishMenu();
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
  assert.equal(f.motion.pendingSelection, undefined);
  assert.equal(f.motion.openingOrDetail, false);
  assert.deepEqual(f.events, [], 'A callback from the previous opening cannot move the new scene');
});

test('skip/replay handoff cannot use an old browse exit to reveal the new menu', () => {
  const f = fixture();
  f.motion.open();
  f.motion.reset();
  f.ready.archive = true; // The replacement scene has completed its skip/replay handoff.
  f.motion.open();
  f.ready.presentation = true;
  f.finishBrowse(); // Completion from before reset.
  f.motion.update();
  assert.equal(f.motion.phase, 'opening');
  assert.ok(!f.events.includes('menu:show'));
  f.finishBrowse();
  f.ready.presentation = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
});

test('latest selection during browse retirement settles its rail before extracting', () => {
  const f = fixture();
  f.motion.open();
  f.motion.select({ index: 2 }, true);
  f.motion.select({ index: 7, navigation: { axis: 'lane', direction: -1 } }, true);
  assert.deepEqual(f.selections(), []);
  assert.deepEqual(f.detailSelections(), []);
  f.finishBrowse();
  assert.equal(f.motion.phase, 'selecting');
  assert.equal(f.selections().at(-1).index, 7);
  assert.ok(!f.events.includes('camera:enter'));
  f.motion.update();
  assert.equal(f.motion.phase, 'selecting');
  f.ready.archive = true;
  f.motion.update();
  f.finishBrowse();
  assert.equal(f.events.filter(event => event === 'camera:enter').length, 1);
  f.ready.presentation = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
});

test('back before extraction invalidates the pending browse callback', () => {
  const f = fixture();
  f.motion.open();
  f.motion.back();
  f.finishBrowse();
  assert.ok(!f.events.includes('camera:enter'));
  f.finishMenu();
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
});

test('interrupted opening ignores stale callbacks and honours a later open request', () => {
  const f = fixture();
  f.motion.open();
  f.motion.back();
  f.motion.open();
  f.finishBrowse();
  f.ready.presentation = true;
  f.motion.update();
  assert.ok(!f.events.includes('menu:show'));
  f.finishMenu();
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'opening');
  f.finishBrowse();
  f.ready.presentation = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
});

test('reduced-motion synchronous callbacks preserve ordering and never deadlock', () => {
  const f = fixture({ reduced: true });
  f.openDetail();
  f.events.length = 0;
  f.motion.select({ index: 2 }, true);
  assert.equal(f.motion.phase, 'switching');
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
  assert.deepEqual(f.events, [
    'menu:hide', { switchDetail: { index: 2 } }, 'menu:prepare', 'menu:show',
  ]);
  f.motion.back();
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
  assert.equal(f.events.at(-1), 'browse:show');
});

test('enabling reduced motion during an exit can finish existing callbacks safely', () => {
  const f = fixture();
  f.openDetail();
  f.motion.select({ index: 3 }, false);
  f.finishMenu();
  // Real ports snap the camera and drain their existing transition callbacks.
  f.ready.archive = true;
  f.motion.update();
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
  assert.deepEqual(f.selections(), [{ index: 3 }]);
  assert.equal(f.events.at(-1), 'browse:show');
});

const { SurfaceTransition } = await import(await transpiledModuleUrl(new URL('../src/ui-transitions.ts', import.meta.url)));
const { setMusicMotionSpeed } = await import(await transpiledModuleUrl(new URL('../src/music-motion-settings.ts', import.meta.url)));

function animationElement(hidden = false) {
  const element = { hidden, dataset: {}, opacity: '1', transform: 'none', animations: [] };
  element.animate = (frames, options) => {
    let resolve, reject, finished;
    let settled = false, cancelled = false;
    const animation = {
      frames, options, playbackRate: 1,
      updatePlaybackRate(rate) { this.playbackRate = rate; },
      get finished() {
        // Native Animation.finished is only observed when its getter is used.
        return finished ??= new Promise((done, fail) => {
          resolve = done;
          reject = fail;
          if (cancelled) fail(new Error('cancelled'));
          else if (settled) done();
        });
      },
      finish() { settled = true; resolve?.(); },
      cancel() { cancelled = true; reject?.(new Error('cancelled')); },
    };
    element.animations.push(animation);
    return animation;
  };
  return element;
}

test('production menu transition moves right and fades before switching the detail album', async (t) => {
  const originalComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (element) => element;
  t.after(() => { globalThis.getComputedStyle = originalComputedStyle; });
  const root = animationElement(), article = animationElement();
  const transition = new SurfaceTransition(root, article, 360, 240, 'right');
  const f = fixture();
  f.openDetail();
  f.ports.hideMenu = (done) => transition.hide(false, done);
  f.motion.select({ index: 6 }, true);
  assert.equal(root.hidden, false, 'Retain the menu while its outgoing frames render');
  assert.equal(root.dataset.transition, 'closing');
  assert.equal(root.animations.at(-1).frames.at(-1).opacity, 0);
  const destination = article.animations.at(-1).frames.at(-1).transform;
  assert.match(destination, /^translateX\([\d.]+px\)$/);
  assert.ok(Number(destination.match(/[\d.]+/)[0]) > 0, 'Exit moves toward screen right');
  assert.ok(!f.events.includes('camera:return'));
  assert.deepEqual(f.detailSelections(), [], 'Do not move the album before its text exits');
  transition.finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(root.hidden, true);
  assert.equal(f.motion.phase, 'switching');
  assert.deepEqual(f.detailSelections(), [{ index: 6 }]);
  assert.equal(f.events.at(-1), 'menu:prepare');
  assert.ok(!f.events.includes('camera:return'));
});

test('production transition cancellation cannot complete an obsolete exit', async (t) => {
  const originalComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (element) => element;
  t.after(() => { globalThis.getComputedStyle = originalComputedStyle; });
  const root = animationElement(), article = animationElement();
  const transition = new SurfaceTransition(root, article, 360, 240, 'right');
  let obsoleteCalls = 0;
  transition.hide(false, () => { obsoleteCalls++; });
  const oldFade = root.animations.at(-1);
  root.opacity = '0.37'; // The browser's current interpolated style on interruption.
  article.transform = 'matrix(1, 0, 0, 1, 23, 0)';
  transition.show(false);
  assert.equal(root.animations.at(-1).frames[0].opacity, '0.37');
  assert.equal(article.animations.at(-1).frames[0].transform, article.transform);
  oldFade.finish();
  transition.finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(obsoleteCalls, 0);
  assert.equal(root.hidden, false);
  assert.equal(root.dataset.transition, 'open');
  let reducedCalls = 0;
  transition.hide(true, () => { reducedCalls++; });
  assert.equal(reducedCalls, 1, 'Reduced motion completes synchronously');
  assert.equal(root.hidden, true);
});

test('music speed retimes an active surface and leaves reduced motion immediate', async (t) => {
  const originalComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (element) => element;
  t.after(() => {
    setMusicMotionSpeed(1);
    globalThis.getComputedStyle = originalComputedStyle;
  });
  setMusicMotionSpeed(0.25);
  const root = animationElement(true), article = animationElement();
  const transition = new SurfaceTransition(root, article, 360, 240, 'right');
  transition.show(false);
  const opening = root.animations.at(-1);
  assert.equal(opening.options.duration, 360, 'Keep base time so in-flight progress stays continuous');
  assert.equal(opening.playbackRate, 0.25);
  opening.currentTime = 90;
  setMusicMotionSpeed(3);
  assert.equal(opening.playbackRate, 3);
  assert.equal(opening.currentTime, 90, 'Changing speed does not restart the surface');
  let completed = 0;
  transition.hide(false, () => completed++);
  assert.equal(root.animations.at(-1).playbackRate, 3, 'A later transition uses current speed');
  transition.finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(completed, 1);
  assert.equal(root.hidden, true);
  const completedRate = root.animations.at(-1).playbackRate;
  setMusicMotionSpeed(0.5);
  assert.equal(root.animations.at(-1).playbackRate, completedRate, 'Completed animation releases its speed listener');
  transition.show(true);
  assert.equal(root.hidden, false);
  assert.equal(root.dataset.transition, 'open');
  transition.dispose();
});

test('near-end reversal resumes at the painted position and finishes in the remaining distance', async (t) => {
  const originalComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (element) => element;
  t.after(() => { globalThis.getComputedStyle = originalComputedStyle; });
  const root = animationElement(), article = animationElement();
  const transition = new SurfaceTransition(root, article, 360, 240, 'right');
  let staleExit = 0;
  transition.hide(false, () => staleExit++);
  // Reverse almost immediately: only 4% opacity and 2 px have departed.
  root.opacity = '0.96';
  article.transform = 'matrix(1, 0, 0, 1, 2, 0)';
  transition.show(false);
  const fade = root.animations.at(-1), move = article.animations.at(-1);
  assert.equal(fade.frames[0].opacity, '0.96');
  assert.equal(move.frames[0].transform, article.transform);
  assert.ok(fade.options.duration >= 72 && fade.options.duration < 100,
    'A tiny reversal must not restart a full 360 ms entrance');
  assert.equal(move.options.duration, fade.options.duration);
  transition.finish();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(staleExit, 0);
  assert.equal(root.dataset.transition, 'open');
  transition.dispose();
});

test('playing panel shrinks before hiding and an interrupted close preserves its visible lifetime', async (t) => {
  const original = globalThis.getComputedStyle;
  globalThis.getComputedStyle = element => element;
  t.after(() => { globalThis.getComputedStyle = original; });
  const root = animationElement(true);
  const transition = new SurfaceTransition(root, root, 320, 240, 'up', undefined, [root], .94);
  transition.show(false);
  transition.finish();
  await Promise.resolve(); await Promise.resolve();
  let closed = 0;
  transition.hide(false, () => closed++);
  assert.equal(root.hidden, false);
  assert.equal(root.dataset.transition, 'closing');
  assert.match(root.animations.at(-1).frames.at(-1).transform, /scale\(0\.94\)/);
  root.opacity = '.45'; root.transform = 'matrix(.97, 0, 0, .97, 0, 3)';
  transition.show(false);
  assert.equal(root.animations.at(-1).frames[0].transform, root.transform);
  transition.finish();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(root.hidden, false);
  assert.equal(closed, 0);
  transition.hide(false, () => closed++);
  assert.equal(root.hidden, false);
  transition.finish();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(root.hidden, true);
  assert.equal(closed, 1);
  transition.show(true); transition.hide(true);
  assert.equal(root.hidden, true);
  transition.dispose();
});
