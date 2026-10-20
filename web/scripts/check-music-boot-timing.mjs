import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const modules = new Map();
function sourceModule(path) {
  const url = new URL(path, import.meta.url);
  if (modules.has(url.href)) return modules.get(url.href);
  const { outputText } = ts.transpileModule(fs.readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  // Node has no stylesheet loader. All production JavaScript remains intact.
  const code = outputText.replace(/^import\s+["'][^"']+\.css["'];?\s*$/gm, '')
    .replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) =>
      `from ${JSON.stringify(specifier.startsWith('.') ? sourceModule(new URL(/\.\w+$/.test(specifier) ? specifier : `${specifier}.ts`, url)) : import.meta.resolve(specifier))}`);
  const compiled = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  modules.set(url.href, compiled);
  return compiled;
}

const timingModule = sourceModule('../src/music-boot-timing.ts');
const { MusicBootFrameClock, MUSIC_BOOT_START_TIME: START, MUSIC_BOOT_END_TIME: END, MUSIC_BOOT_SCENE_REVEAL_TIME, MUSIC_BOOT_SCENE_START, musicBootSceneTime } = await import(timingModule);
const { MusicBoot } = await import(sourceModule('../src/music-boot.ts'));
const { musicOpeningFrame, MUSIC_OPENING_SLOGAN } = await import(sourceModule('../src/music-opening.ts'));
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9,
  `${message}: expected ${expected}, received ${actual}`);

for (const fps of [30, 60, 120]) {
  const clock = new MusicBootFrameClock();
  clock.reset(100);
  close(clock.update(100), START, 'First frame starts at the authored opening');
  const frames = Math.round((END - START) * fps);
  for (let frame = 1; frame <= frames; frame++) {
    close(clock.update(100 + frame / fps), Math.min(END, START + frame / fps),
      `Normal ${fps} fps playback retains the 8 second duration`);
  }
  assert.equal(clock.update(100 + frames / fps), END, 'Final frame is exact, without an extra rounding frame');
  assert.equal(clock.update(200), END, 'A completed clock stays at the endpoint');
}

const cold = new MusicBootFrameClock();
cold.reset(10);
close(cold.update(10), START, 'Cold start begins with its first frame');
close(cold.update(13.5), START + 0.05, 'A 3.5 second first-render shader compile consumes only one bounded frame');
close(cold.update(13.5 + 1 / 60), START + 0.05 + 1 / 60, 'The next frame has no catch-up backlog');
const beforeHidden = cold.update(13.6);
close(cold.update(313.6), beforeHidden + 0.05, 'A hidden tab does not skip the remaining opening');
const beforeInvalid = cold.update(313.7);
for (const invalid of [NaN, Infinity, -Infinity, 200, 313.7]) {
  assert.equal(cold.update(invalid), beforeInvalid, 'Invalid or backward timestamps cannot rewind or advance the film');
}
close(cold.update(313.7 + 1 / 60), beforeInvalid + 1 / 60, 'Backward timestamps do not alter the previous valid clock sample');
cold.reset(500);
assert.equal(cold.update(500), START, 'A restarted opening discards all prior progress');
close(cold.update(550), START + 0.05, 'A stall before the first animation callback is bounded too');

// Minimal DOM doubles exercise the real MusicBoot state machine, including its
// one-frame endpoint handoff, skip callback and reduced-motion branch.
const controlAnimations = [];
class FakeAnimation {
  constructor(target, frames, options) {
    Object.assign(this, { target, frames, options });
    this.finished = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.finished.catch(() => {});
    controlAnimations.push(this);
  }
  finish() { this.resolve(); }
  cancel() { this.reject(new Error('cancelled')); }
}
class FakeElement {
  children = [];
  dataset = {};
  hidden = false;
  inert = false;
  isConnected = true;
  className = '';
  attributes = new Map();
  properties = new Map();
  classList = { contains: (value) => this.className.split(' ').includes(value) };
  style = {
    getPropertyValue: (name) => this.properties.get(name)?.value ?? '',
    getPropertyPriority: (name) => this.properties.get(name)?.priority ?? '',
    setProperty: (name, value, priority = '') => this.properties.set(name, { value, priority }),
    removeProperty: (name) => this.properties.delete(name),
  };
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener() {}
  queries = new Map();
  querySelector(selector) {
    if (selector.startsWith('.')) {
      for (const child of this.children) {
        if (child.classList.contains(selector.slice(1))) return child;
        const descendant = child.querySelector(selector);
        if (descendant) return descendant;
      }
      return null;
    }
    if (!selector.startsWith('[data-opening=')) return null;
    if (!this.queries.has(selector)) this.queries.set(selector, new FakeElement());
    return this.queries.get(selector);
  }
  contains(child) { return this === child || this.children.some((entry) => entry.contains(child)); }
  closest() { return this.hidden || this.inert ? this : null; }
  focus() { document.activeElement = this; }
  animate(frames, options) { return new FakeAnimation(this, frames, options); }
  remove() { this.isConnected = false; this.parent.children = this.parent.children.filter((entry) => entry !== this); }
}
globalThis.HTMLElement = FakeElement;
globalThis.document = {
  createElement: () => new FakeElement(),
  body: new FakeElement(),
  activeElement: null,
};
document.activeElement = document.body;
globalThis.getComputedStyle = () => ({ opacity: '1', translate: 'none' });

function bootFixture(reduced = false, withHeader = false) {
  const stage = new FakeElement();
  const scene = new FakeElement(); scene.className = 'three-scene';
  const controls = new FakeElement(); controls.style.setProperty('visibility', 'collapse', 'important');
  stage.appendChild(scene); stage.appendChild(controls);
  const header = new FakeElement(); header.className = 'music-header';
  const identity = new FakeElement(); identity.className = 'music-identity';
  const brand = new FakeElement(); brand.className = 'music-brand';
  const navigation = new FakeElement(); navigation.className = 'music-topnav';
  const button = new FakeElement(); button.className = 'custom-control';
  identity.appendChild(brand); navigation.appendChild(button);
  header.appendChild(identity); header.appendChild(navigation);
  if (withHeader) stage.appendChild(header);
  const completed = [];
  let started = 0;
  const boot = new MusicBoot(stage, {
    reduced,
    onStart: () => { started++; },
    onComplete: (reason) => completed.push(reason),
  });
  return { boot, stage, scene, controls, header, identity, brand, navigation, button,
    completed, get started() { return started; } };
}

const actual = bootFixture();
assert.equal(actual.boot.root.querySelector('.music-boot-skip'), null, 'The opening has no skip button');
actual.boot.start(100);
assert.equal(actual.boot.update(100).appTime, START);
assert.equal(actual.scene.inert, true);
assert.equal(actual.controls.style.getPropertyValue('visibility'), 'hidden');
close(actual.boot.update(103.5).appTime, START + 0.05, 'Actual MusicBoot uses the bounded clock after shader compilation');
assert.equal(actual.boot.update(203.5).phase, 'logo', 'A long pause cannot jump actual MusicBoot to its final selection');
assert.deepEqual(actual.completed, [], 'A pause cannot complete the intro');
actual.boot.replay(500);
assert.equal(actual.boot.update(500).appTime, START, 'Actual replay resets the displayed film time');
const totalFrames = Math.round((END - START) * 60);
for (let frame = 1; frame <= totalFrames; frame++) {
  const rendered = actual.boot.update(500 + frame / 60);
  assert.ok(rendered, 'The opening emits a frame throughout the prologue and live shelf');
  assert.equal(rendered.renderScene, rendered.appTime >= MUSIC_BOOT_SCENE_REVEAL_TIME,
    'The live scene runs only once the opaque paper starts its dissolve');
  if (!rendered.renderScene) assert.equal(musicOpeningFrame(rendered.appTime).background, 1,
    'Every skipped scene frame is fully covered by the opening art');
  assert.equal(rendered.cinema.time, musicBootSceneTime(rendered.appTime), 'Camera, geometry and lighting share one bounded clock');
}
assert.equal(actual.stage.children.at(-1).dataset.appTime, String(END));
assert.deepEqual(actual.completed, [], 'The endpoint is rendered before completion is announced');
assert.equal(actual.boot.update(500 + (totalFrames + 1) / 60), undefined);
assert.deepEqual(actual.completed, ['complete'], 'Completion fires once on the frame after the endpoint');
await Promise.resolve();
assert.equal(actual.boot.active, false, 'The existing control reveal completes normally');
assert.equal(actual.controls.inert, false);
assert.equal(actual.controls.style.getPropertyValue('visibility'), 'collapse');
assert.equal(actual.controls.style.getPropertyPriority('visibility'), 'important');

const skipped = bootFixture();
skipped.boot.start(0); skipped.boot.update(0); skipped.boot.update(3.5);
skipped.boot.skip();
assert.deepEqual(skipped.completed, ['skip'], 'Skip still bypasses the opening immediately');
await Promise.resolve();
assert.equal(skipped.boot.active, false);
assert.equal(skipped.boot.update(100), undefined, 'Skipped frames cannot resume the timeline');

const reduced = bootFixture(true);
reduced.boot.start(0);
assert.equal(reduced.started, 1);
assert.deepEqual(reduced.completed, ['skip'], 'Reduced motion retains its immediate skip');
assert.equal(reduced.boot.active, false);
reduced.boot.replay(20);
assert.equal(reduced.boot.active, false, 'Replay also honours reduced motion');
assert.deepEqual(reduced.completed, ['skip', 'skip']);
reduced.boot.dispose();
assert.equal(reduced.boot.active, false);

let reduceNow = false;
const changed = bootFixture(() => reduceNow);
changed.boot.start(0);
changed.boot.update(0);
reduceNow = true;
assert.equal(changed.boot.update(1 / 60), undefined);
assert.equal(changed.boot.active, false, 'A reduced-motion preference change skips an in-flight opening');
assert.deepEqual(changed.completed, ['skip']);

assert.equal(MUSIC_OPENING_SLOGAN, '一张一张，慢慢听');
const openingMarkup = actual.boot.root.children[0].innerHTML;
assert.ok(!openingMarkup.includes('music-opening-brand'), 'The opening must not create a second header brand');
assert.ok(!openingMarkup.includes('music-opening-rule'), 'The slogan no longer owns a horizontal rule');
assert.equal(musicBootSceneTime(0), 21.92);
assert.equal(musicBootSceneTime(MUSIC_BOOT_SCENE_START), 21.92, 'Prewarming the scene does not consume its authored sweep');
close(musicBootSceneTime(END), 27.12, 'The original live-scene endpoint is unchanged');
assert(openingMarkup.includes('music-opening-mark') && openingMarkup.includes('music-opening-orbit'),'Restore the existing Rhine mark and rotating disc artwork');
assert.equal(musicOpeningFrame(1).mark,1);
assert(musicOpeningFrame(2.4).orbit>0.5);
assert(musicOpeningFrame(2.4).orbitTurn>musicOpeningFrame(2).orbitTurn,'The disc rotates on the bounded animation clock');
for (let time = 3.04; time <= 3.56; time += 1 / 120) {
  const frame = musicOpeningFrame(time);
  assert.equal(frame.title, 1, 'The entire slogan remains still and fully readable through its hold');
}
const opacityTracks = ['background', 'mark', 'symbols', 'orbit', 'title', 'subtitle'];
let previous = musicOpeningFrame(0);
for (let time = 1 / 120; time <= END; time += 1 / 120) {
  const frame = musicOpeningFrame(time);
  for (const track of opacityTracks) {
    assert.ok(frame[track] >= 0 && frame[track] <= 1);
    assert.ok(Math.abs(frame[track] - previous[track]) < 0.075, `${track} has no editorial opacity jump`);
  }
  previous = frame;
}
assert.equal(musicOpeningFrame(4.38).background, 0, 'The prologue releases the live scene completely');

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
// Reusing the real DOM also reuses all responsive geometry. Exercise its actual
// visibility/inert lifecycle, including prior child state and interrupted replay.
const shared = bootFixture(false, true);
shared.navigation.style.setProperty('visibility', 'collapse', 'important');
shared.navigation.inert = true;
shared.button.style.setProperty('visibility', 'hidden', 'important');
shared.button.inert = true;
shared.boot.start(0);
assert.equal(shared.stage.querySelector('.music-brand'), shared.brand);
assert.equal(shared.brand.parent, shared.identity);
assert.equal(shared.identity.parent, shared.header);
assert.equal(shared.header.style.getPropertyValue('visibility'), 'hidden', 'The film keeps the header hidden until its live-scene handoff');
assert.equal(shared.identity.style.getPropertyValue('visibility'), '');
assert.equal(shared.brand.style.getPropertyValue('visibility'), '');
assert.equal(shared.header.inert, true, 'The visible brand link remains outside the intro focus order');
assert.equal(shared.navigation.style.getPropertyValue('visibility'), 'hidden');
assert.equal(shared.button.style.getPropertyValue('visibility'), 'hidden', 'Nested control overrides are untouched');
const revealStart = controlAnimations.length;
shared.boot.skip();
assert.equal(shared.boot.active, true, 'Controls still own their reveal lifecycle after skip');
assert.equal(shared.navigation.style.getPropertyValue('visibility'), 'collapse');
assert.equal(shared.navigation.style.getPropertyPriority('visibility'), 'important');
const oldReveal = controlAnimations.slice(revealStart);
assert.equal(oldReveal.length, 2);
assert.equal(oldReveal[0].target, shared.identity, 'The existing brand joins the controls at the handoff');
shared.boot.replay(10);
oldReveal.forEach(animation => animation.finish());
await flush();
assert.equal(shared.stage.dataset.musicBoot, 'running', 'An obsolete reveal cannot finish a replay');
assert.equal(shared.navigation.style.getPropertyValue('visibility'), 'hidden');
assert.equal(shared.header.style.getPropertyValue('visibility'), 'hidden');
shared.boot.skip();
controlAnimations.slice(revealStart).forEach(animation => animation.finish());
await flush();
assert.equal(shared.boot.active, false);
assert.equal(shared.header.inert, false);
assert.equal(shared.navigation.inert, true, 'Original nested inert state is restored after revealing');
assert.equal(shared.button.inert, true);
assert.equal(shared.button.style.getPropertyPriority('visibility'), 'important');
assert.equal(shared.stage.querySelector('.music-brand'), shared.brand, 'The same brand survives the handoff');
shared.boot.replay(20); shared.boot.dispose();
assert.equal(shared.header.inert, false, 'Disposal also releases the persistent header');
assert.equal(shared.navigation.style.getPropertyValue('visibility'), 'collapse');
assert.equal(shared.navigation.style.getPropertyPriority('visibility'), 'important');
assert.equal(shared.navigation.inert, true);

let sharedReduced = false;
const reducedHeader = bootFixture(() => sharedReduced, true);
reducedHeader.boot.start(0); reducedHeader.boot.skip();
assert.equal(reducedHeader.boot.active, true);
sharedReduced = true; reducedHeader.boot.update(.02);
assert.equal(reducedHeader.boot.active, false, 'Live reduced motion finishes the new brand and navigation reveal');
assert.equal(reducedHeader.header.inert, false);
assert.equal(reducedHeader.navigation.inert, false);
assert.equal(reducedHeader.header.style.getPropertyValue('visibility'), '');
assert.equal(reducedHeader.navigation.style.getPropertyValue('visibility'), '');
reducedHeader.boot.replay(30);
assert.equal(reducedHeader.boot.active, false);
assert.equal(reducedHeader.stage.querySelector('.music-brand'), reducedHeader.brand);
reducedHeader.boot.dispose();

for (const fps of [20,30,60,120]) {
  const gate = bootFixture();
  gate.boot.start(0);
  let skipped = 0, rendered = 0, firstSceneFrame;
  for (let step=0;step<=Math.round(END*fps);step++) {
    const frame = gate.boot.update(step/fps);
    if (!frame) continue;
    if (frame.renderScene) { rendered++; firstSceneFrame ??= frame; }
    else skipped++;
  }
  assert.ok(skipped >= Math.floor(MUSIC_BOOT_SCENE_REVEAL_TIME*fps),
    `At ${fps} fps the fully opaque intro avoids repeated WebGL rendering`);
  assert.ok(rendered > 0 && firstSceneFrame.appTime <= MUSIC_BOOT_SCENE_REVEAL_TIME + 1/fps + 1e-9,
    'The first partially transparent frame has a live scene behind it');
  close(firstSceneFrame.cinema.time, 21.92,
    'Dissolve pre-roll starts at the original scene frame, before shelf motion advances');
  gate.boot.dispose();
}
console.log('Music boot passed: 8 seconds at 30/60/120 fps; Rhine mark and rotating disc restored; 3.92s dissolve pre-roll at 20/30/60/120 fps; 1.3× live-scene clock with the original endpoint; slogan continuity, nested control restoration, cold compilation, suspension, interrupted replay, endpoint handoff and reduced motion.');
