import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const modules = new Map();
async function compiled(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  let { outputText } = ts.transpileModule(await readFile(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  for (const [, specifier] of [...outputText.matchAll(/from\s+["']([^"']+)["']/g)]) {
    const dependency = specifier.startsWith('.')
      ? await compiled(new URL(specifier.endsWith('.ts') ? specifier : `${specifier}.ts`, url))
      : import.meta.resolve(specifier);
    outputText = outputText.replaceAll(`"${specifier}"`, JSON.stringify(dependency))
      .replaceAll(`'${specifier}'`, JSON.stringify(dependency));
  }
  const result = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
  modules.set(url.href, result);
  return result;
}
const { MusicOverviewUI } = await import(await compiled(new URL('../src/music-overview-ui.ts', import.meta.url)));
const { setMusicMotionSpeed } = await import(await compiled(new URL('../src/music-motion-settings.ts', import.meta.url)));
const { visibleOverviewLabels } = await import(await compiled(new URL('../src/music-overview.ts', import.meta.url)));
const animations = [];
class Animation {
  currentTime = 0; playbackRate = 1; playState = 'running';
  constructor(element, frames, options) {
    Object.assign(this, { element, frames, options });
    this.finished = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.finished.catch(() => {});
    animations.push(this);
  }
  updatePlaybackRate(value) { this.playbackRate = value; }
  cancel() { this.playState = 'idle'; this.reject(new Error('cancelled')); }
  finish() { this.playState = 'finished'; this.currentTime = this.options.duration; this.resolve(); }
}
class Element {
  children = []; style = {}; dataset = {}; attrs = {}; hidden = false; inert = false;
  constructor(name = 'div', className = '') { this.name = name; this.className = className; }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  set innerHTML(_value) {
    const card = new Element('div', 'overview-column');
    const label = new Element('button', 'overview-column-label');
    label.append(new Element('strong'), new Element('small'));
    const slot = new Element('span', 'overview-enter-slot');
    const enter = new Element('button', 'overview-enter');
    slot.append(enter); card.append(label, slot); this.append(card);
  }
  setAttribute(key, value) { this.attrs[key] = value; }
  querySelectorAll(selector) {
    const choices = selector.split(',').map(x => x.trim());
    return this.children.flatMap(child => [
      ...(choices.some(x => x.startsWith('.') ? child.className === x.slice(1) : child.name === x) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
  focus() { document.activeElement = this; }
  remove() { this.parent.children = this.parent.children.filter(item => item !== this); }
  animate(frames, options) { return new Animation(this, frames, options); }
}
globalThis.document = { activeElement: null, createElement: name => new Element(name) };
globalThis.getComputedStyle = element => {
  const fade = animations.findLast(a => a.element === element && a.playState !== 'idle' && 'opacity' in a.frames[0]);
  const value = fade ? Number(fade.frames[0].opacity) + (Number(fade.frames[1].opacity) - Number(fade.frames[0].opacity)) * Math.min(1, fade.currentTime / fade.options.duration) : 1;
  return { opacity: String(value), transform: 'translateY(0px)' };
};
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
async function advance(ms) {
  for (const animation of animations) if (animation.playState === 'running') {
    animation.currentTime += ms * animation.playbackRate;
    if (animation.currentTime >= animation.options.duration) animation.finish();
  }
  await flush();
}
function fixture() {
  const surface = new Element(), container = new Element(); surface.hidden = true;
  const chrome = ['overview-heading', 'overview-controls', 'overview-return'].map(name => new Element('div', name));
  surface.append(...chrome, container);
  const ui = new MusicOverviewUI(surface, container, () => chrome[2].focus());
  return { ui, surface, container, chrome };
}
const column = (lane, x) => ({ lane, name: `Artist ${lane}`, count: 3, x, y: 300, selected: lane === 0 });
const update = (f, columns, reduced = false) => f.ui.update(columns, 1280, 720, 1, reduced, '歌手');

{
  const f = fixture(); f.ui.setActive(true, false); update(f, [column(0, 400), column(1, 650)]);
  const first = f.container.children[0], second = f.container.children[1];
  const firstCard = first.querySelector('.overview-column');
  assert.equal(f.ui.canEnter(0), false);
  f.ui.expand(0);
  assert.equal(f.ui.canEnter(0), true);
  assert.equal(first.style.left, '400.00px', 'Expanding an entry must not relocate its projected artist');
  assert.equal(firstCard.dataset.expanded, 'true');
  f.ui.expand(1);
  assert.equal(f.ui.canEnter(0), false); assert.equal(f.ui.canEnter(1), true);
  assert.equal(firstCard.dataset.expanded, 'false');
  assert.equal(second.querySelector('.overview-enter').disabled, false);
  assert.ok(!animations.some(a => a.element === first && a.frames.some(frame => 'transform' in frame)), 'Motion transforms belong to the inner card only');
  await advance(500);
  update(f, [column(1, 700)]);
  assert.equal(f.container.children.length, 2, 'The departing label remains mounted for its exit');
  assert.equal(first.inert, true);
  await advance(80);
  update(f, [column(0, 405), column(1, 700)]);
  await advance(500);
  assert.equal(f.container.children[0], first, 'A reversal reuses the current card, and stale exit callbacks cannot remove it');
  assert.equal(first.style.left, '405.00px');
  f.ui.setActive(false, false);
  assert.equal(f.surface.hidden, false, 'Overview remains mounted throughout its exit');
  await advance(60); f.ui.setActive(true, false); update(f, [column(0, 415)]);
  await advance(600); assert.equal(f.surface.hidden, false, 'An interrupted exit cannot hide the reopened overview');
  f.ui.dispose();
}
{
  const f = fixture(); f.ui.setActive(true, false); update(f, [{ ...column(0, 400), extent: .3 }]);
  const anchor = f.container.children[0];
  assert.equal(anchor.style.opacity, '0.3');
  await advance(500);
  update(f, [{ ...column(0, 420), extent: .04 }]);
  assert.equal(anchor.inert, true, 'A physically vanishing column retires its interactive label');
  assert.equal(anchor.style.left, '420.00px');
  assert.equal(anchor.style.opacity, '0.04');
  assert.ok(!animations.some(a => a.element === anchor && a.frames.some(frame => 'opacity' in frame)), 'Physical opacity cannot be overridden by the UI fade');
  update(f, [{ ...column(0, 430), extent: 0 }]);
  assert.equal(anchor.style.left, '430.00px', 'An exiting label continues following the physical edge');
  assert.equal(anchor.style.opacity, '0', 'The label is fully invisible before a pool slot can recycle');
  await advance(300); assert.equal(f.container.children.length, 0);
  f.ui.dispose();
}
{
  setMusicMotionSpeed(.25);
  const f = fixture(); f.ui.setActive(true, false); update(f, [column(0, 400)]);
  await advance(2000); f.ui.setActive(false, false);
  await advance(600);
  assert.equal(f.surface.hidden, false, 'Slow exits are retained beyond the former fixed wall-clock duration');
  assert.equal(f.container.children.length, 1);
  setMusicMotionSpeed(3); await advance(100);
  assert.equal(f.surface.hidden, true); assert.equal(f.container.children.length, 0);
  f.ui.setActive(true, true); update(f, [column(0, 400)], true);
  assert.equal(f.container.children.length, 1);
  f.ui.setActive(false, true);
  assert.equal(f.surface.hidden, true); assert.equal(f.container.children.length, 0);
  f.ui.dispose(); setMusicMotionSpeed(1);
}
{
  const edge = column(0, 88);
  assert.equal(visibleOverviewLabels([edge], 1280, 720).length, 0);
  assert.equal(visibleOverviewLabels([edge], 1280, 720, new Set([0])).length, 1, 'Retained edge labels have hysteresis');
  assert.equal(visibleOverviewLabels([column(0, 400), column(1, 600)], 1280, 720, new Set(), 0).length, 1, 'An expanded entry owns its extra horizontal space');
  for (const [width, x, labelWidth] of [[1280, 1180, 160], [393, 260, 116]]) {
    assert.equal(visibleOverviewLabels([column(0, x)], width, 720).length, 0, 'A new label must reserve its full right-hand entry before appearing');
    assert.equal(visibleOverviewLabels([column(0, x)], width, 720, new Set([0]), 0).length, 0, 'Exit hysteresis must not retain a clipped entry control');
    const safeX = width - labelWidth / 2 - 76 - 34;
    assert.equal(visibleOverviewLabels([column(0, safeX)], width, 720, new Set(), 0).length, 1);
    assert.ok(safeX + labelWidth / 2 + 76 <= width - 14);
  }
}
console.log('Overview UI: two-step entry, stable projected anchors, reversible label and surface lifetimes, edge hysteresis, expanded collision bounds, dynamic speed and reduced motion passed.');
