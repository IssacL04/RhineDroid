import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Exercise production controllers with a controllable DOM/WAAPI clock. Compile
// their local dependencies too, retaining one shared motion-settings instance.
const moduleUrls = new Map();
async function transpiledModuleUrl(url) {
  if (moduleUrls.has(url.href)) return moduleUrls.get(url.href);
  const source = await readFile(url, 'utf8');
  let { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  for (const [, specifier] of [...outputText.matchAll(/from\s+["'](\.[^"']+)["']/g)]) {
    const path = /\.[a-z]+$/i.test(specifier) ? specifier : `${specifier}.ts`;
    const dependencyUrl = new URL(path, url);
    const dependency = path.endsWith('.ts')
      ? await transpiledModuleUrl(dependencyUrl)
      : dependencyUrl.href;
    outputText = outputText.replaceAll(`"${specifier}"`, JSON.stringify(dependency))
      .replaceAll(`'${specifier}'`, JSON.stringify(dependency));
  }
  const result = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
  moduleUrls.set(url.href, result);
  return result;
}
const { setMusicMotionSpeed } = await import(await transpiledModuleUrl(new URL('../src/music-motion-settings.ts', import.meta.url)));
const { createTitleReels } = await import(await transpiledModuleUrl(new URL('../src/music-title-reels.ts', import.meta.url)));
const { setupMusicRuler } = await import(await transpiledModuleUrl(new URL('../src/music-ruler.ts', import.meta.url)));
const settleMicrotasks = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function fixture(t) {
  let now = 0, nextId = 0;
  const frames = new Map(), timers = new Map(), animations = [], cleanups = [];
  class TestAnimation {
    playbackRate = 1;
    currentTime = 0;
    playState = 'running';
    onfinish;
    constructor(options) {
      this.options = options;
      this.finished = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
      this.finished.catch(() => {});
      animations.push(this);
    }
    updatePlaybackRate(rate) { this.playbackRate = rate; }
    finish() {
      this.playState = 'finished';
      this.currentTime = this.options.duration;
      this.resolve();
      this.onfinish?.();
    }
    cancel() {
      if (this.playState !== 'finished') this.reject(new Error('cancelled'));
      this.playState = 'idle';
    }
  }
  class Element {
    style = {
      setProperty(key, value) { this[key] = value; },
      getPropertyValue(key) { return this[key] || ''; },
    };
    dataset = {};
    children = [];
    attrs = {};
    classList = { add() {}, toggle() {} };
    ownerDocument = { timeline: { get currentTime() { return now; } } };
    appendChild(child) { this.children.push(child); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attrs[key] = value; }
    removeAttribute(key) { delete this.attrs[key]; }
    addEventListener() {}
    remove() {}
    focus() { document.activeElement = this; }
    animate(_frames, options) { return new TestAnimation(options); }
  }
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  const overrides = {
    matchMedia: () => media,
    performance: { now: () => now },
    requestAnimationFrame: callback => { frames.set(++nextId, callback); return nextId; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (callback, delay = 0) => { timers.set(++nextId, { callback, at: now + delay }); return nextId; },
    clearTimeout: id => timers.delete(id),
    window: { addEventListener() {} },
    document: { hidden: false, createElement: () => new Element(), activeElement: null },
    getComputedStyle: element => ({ getPropertyValue: key => element.style.getPropertyValue(key) }),
  };
  const originals = new Map(Object.keys(overrides).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, overrides);
  t.after(async () => {
    cleanups.forEach(cleanup => cleanup());
    await settleMicrotasks();
    setMusicMotionSpeed(1);
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const advance = (milliseconds, steps = 1) => {
    for (let step = 0; step < steps; step++) {
      const delta = milliseconds / steps;
      now += delta;
      for (const animation of [...animations]) {
        if (animation.playState !== 'running') continue;
        animation.currentTime += delta * animation.playbackRate;
        if (animation.currentTime >= animation.options.duration) animation.finish();
      }
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(callback => callback(now));
    }
  };
  return { Element, animations, advance, cleanups };
}

const glyph = text => ({ key: 'main:0', text, kind: 'main', x: 0, y: 0, width: 20, height: 24, font: '24px serif', letterSpacing: '0px' });

// The old fixed 500 ms cleanup would finish a 0.25× reel over a second early.
test('slow title reels retain their faces until their actual animations finish', async (t) => {
  const f = fixture(t);
  setMusicMotionSpeed(0.25);
  const title = createTitleReels(new f.Element(), new f.Element());
  f.cleanups.push(() => title.destroy());
  title.render([glyph('A')], 24, false);
  title.render([glyph('B')], 24, true);
  assert.ok(f.animations.length > 0);
  assert.equal(f.animations.at(-1).playbackRate, 0.25);
  f.advance(600);
  await settleMicrotasks();
  assert.equal(title.moving, true, 'A slow reel must survive the former fixed cleanup deadline');
  assert.equal(f.animations.at(-1).playState, 'running');
  f.advance(1240);
  await settleMicrotasks();
  assert.equal(title.moving, false, 'Cleanup follows actual completion at 1840 ms');
});

test('interrupted title cleanup cannot settle the replacement and mid-roll speed keeps progress', async (t) => {
  const f = fixture(t);
  setMusicMotionSpeed(0.25);
  const title = createTitleReels(new f.Element(), new f.Element());
  f.cleanups.push(() => title.destroy());
  title.render([glyph('A')], 24, false);
  title.render([glyph('B')], 24, true);
  f.advance(120);
  const oldTracks = [...f.animations];
  const nextIndex = f.animations.length;
  title.render([glyph('C')], 24, true);
  oldTracks.forEach(animation => animation.finish());
  await settleMicrotasks();
  assert.equal(title.moving, true, 'Obsolete finish/rejection cannot clean up the current title');
  const nextTracks = f.animations.slice(nextIndex);
  assert.ok(nextTracks.length > 0);
  f.advance(80);
  const times = nextTracks.map(animation => animation.currentTime);
  setMusicMotionSpeed(3);
  assert.deepEqual(nextTracks.map(animation => animation.currentTime), times, 'Speed changes preserve the sampled glyph position');
  assert.ok(nextTracks.every(animation => animation.playbackRate === 3));
  f.advance(160);
  await settleMicrotasks();
  assert.equal(title.moving, false);
});

test('ruler springs and ripple delays produce equal output at equal scaled time', (t) => {
  const f = fixture(t);
  const state = (speed, wallTime, regroup) => {
    setMusicMotionSpeed(speed);
    const host = new f.Element();
    const ruler = setupMusicRuler(host);
    f.cleanups.push(() => ruler.destroy());
    const items = Array.from({ length: 16 }, (_, index) => ({ index, title: String(index) }));
    ruler.update(items, 0, false);
    f.advance(2000 / speed, 240);
    const nextItems = regroup ? items.map(item => ({ ...item, id: `next:${item.index}` })) : items;
    ruler.update(nextItems, 4, false, { axis: 'row', direction: 1 });
    f.advance(wallTime, 120);
    const result = host.children.map(button => ({
      transform: button.style.transform,
      opacity: Number(button.style.opacity).toFixed(8),
      height: button.children[0].style['--ruler-height'],
      markOpacity: Number(button.children[0].style['--ruler-opacity']).toFixed(8),
    }));
    ruler.destroy();
    return result;
  };
  assert.deepEqual(state(0.25, 800, false), state(2, 100, false), 'Selection springs share the scaled clock');
  assert.deepEqual(state(0.25, 800, true), state(2, 100, true), 'Staggered category ripples share the same clock');
});

const rulerItems = count => Array.from({ length: count }, (_, index) => ({ index, title: `Album ${index}` }));
const visibleRuler = host => host.children.filter(button => !button.disabled)
  .sort((a, b) => parseFloat(a.style.transform.slice(12)) - parseFloat(b.style.transform.slice(12)));

test('finite long rulers stop at real first and last albums without placeholder or wrapped ticks', t => {
  const f = fixture(t), host = new f.Element(), ruler = setupMusicRuler(host), items = rulerItems(20);
  f.cleanups.push(() => ruler.destroy());
  ruler.update(items, 0, false, undefined, false);
  assert.deepEqual(visibleRuler(host).map(button => Number(button.dataset.select)), Array.from({ length: 12 }, (_, index) => index));
  assert.equal(visibleRuler(host)[0].dataset.rulerStep, '0');
  const nodes = [...host.children];
  ruler.update(items, 19, false, { axis: 'row', direction: 19 }, false);
  f.advance(2000, 240);
  assert.deepEqual(visibleRuler(host).map(button => Number(button.dataset.select)), Array.from({ length: 12 }, (_, index) => index + 8));
  assert.equal(visibleRuler(host).at(-1).dataset.rulerStep, '0');
  for (const button of host.children) {
    if (button.dataset.select !== undefined) {
      const index = Number(button.dataset.select);
      assert.ok(index >= 0 && index < items.length);
      assert.equal(Number(button.dataset.rulerStep), index - 19, 'Each selectable mark addresses its actual distance from the last album');
    }
    else {
      assert.equal(button.disabled, true);
      assert.equal(button.tabIndex, -1);
      assert.equal(button.attrs['aria-hidden'], 'true');
      assert.equal(button.dataset.rulerStep, undefined);
    }
  }
  assert.deepEqual(host.children, nodes, 'The finite ruler keeps the existing reusable node pool');
});

test('finite ruler reversals preserve the displayed ticks and reduced motion settles immediately', t => {
  const f = fixture(t), host = new f.Element(), ruler = setupMusicRuler(host), items = rulerItems(40);
  f.cleanups.push(() => ruler.destroy());
  ruler.update(items, 0, false, undefined, false);
  ruler.update(items, 39, false, { axis: 'row', direction: 39 }, false);
  f.advance(120, 20);
  const displayed = visibleRuler(host).map(button => [button, button.style.transform, button.dataset.select]);
  ruler.update(items, 2, false, { axis: 'row', direction: -37 }, false);
  for (const [button, position, index] of displayed) {
    assert.equal(button.style.transform, position, 'Retargeting keeps the sampled displayed tick position');
    assert.equal(button.dataset.select, index, 'Visible nodes do not become another album during reversal');
  }
  f.advance(2000, 240);
  assert.deepEqual(visibleRuler(host).map(button => Number(button.dataset.select)), Array.from({ length: 12 }, (_, index) => index));
  ruler.update(items, 39, true, { axis: 'row', direction: 37 }, false);
  assert.deepEqual(visibleRuler(host).map(button => Number(button.dataset.select)), Array.from({ length: 12 }, (_, index) => index + 28));
  assert.equal(visibleRuler(host).at(-1).attrs['aria-current'], 'true');
});

test('live ruler mode changes normalize old loop periods and preserve filled looping', t => {
  const f = fixture(t), host = new f.Element(), ruler = setupMusicRuler(host), items = rulerItems(20);
  f.cleanups.push(() => ruler.destroy());
  ruler.update(items, 0, true);
  assert.ok(visibleRuler(host).some(button => Number(button.dataset.select) === 19), 'Filled first album retains the preceding loop occurrence');
  ruler.update(items, 19, true, { axis: 'row', direction: -1 });
  assert.ok(visibleRuler(host).some(button => Number(button.dataset.select) === 0));
  document.activeElement = visibleRuler(host).find(button => Number(button.dataset.select) === 0);
  ruler.update(items, 19, true, undefined, false);
  assert.deepEqual(visibleRuler(host).map(button => Number(button.dataset.select)), Array.from({ length: 12 }, (_, index) => index + 8));
  assert.equal(document.activeElement.disabled, false, 'A removed loop occurrence cannot strand keyboard focus');
  ruler.update(items, 19, true, undefined, true);
  assert.ok(visibleRuler(host).some(button => Number(button.dataset.select) === 0), 'Filled mode restores tail-to-first occurrences');
});

test('finite short, single and empty rulers expose only existing albums', t => {
  const f = fixture(t), host = new f.Element(), ruler = setupMusicRuler(host);
  f.cleanups.push(() => ruler.destroy());
  for (const count of [12, 3, 1, 0]) {
    ruler.update(rulerItems(count), Math.max(0, count - 1), true, undefined, false);
    assert.deepEqual(visibleRuler(host).map(button => Number(button.dataset.select)), Array.from({ length: count }, (_, index) => index));
    assert.ok(host.children.filter(button => button.disabled).every(button => button.tabIndex === -1));
    assert.equal(host.children.length, 16);
  }
});
