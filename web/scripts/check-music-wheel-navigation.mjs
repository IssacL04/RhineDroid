import assert from "node:assert/strict";
import {
  musicWheelDelta,
  MusicWheelSteps,
  mountMusicWheelNavigation,
} from "../src/music-wheel-navigation.ts";

const input = (deltaY, overrides = {}) => ({
  deltaY,
  deltaX: 0,
  deltaMode: 0,
  ctrlKey: false,
  shiftKey: false,
  ...overrides,
});
assert.equal(
  musicWheelDelta(input(3, { deltaMode: 1 }), 800),
  48,
  "Three line units equal one normal wheel step",
);
assert.equal(
  musicWheelDelta(input(-1, { deltaMode: 2 }), 800),
  -800,
  "Page units use the browse viewport height",
);
assert.equal(
  musicWheelDelta(input(100, { ctrlKey: true }), 800),
  0,
  "Pinch and Ctrl+wheel retain browser zoom",
);
assert.equal(
  musicWheelDelta(input(100, { shiftKey: true }), 800),
  0,
  "Shift+wheel is not album navigation",
);
assert.equal(
  musicWheelDelta(input(10, { deltaX: 100 }), 800),
  0,
  "Horizontal trackpad gestures never switch columns",
);
assert.equal(musicWheelDelta(input(NaN), 800), 0);

const steps = new MusicWheelSteps();
assert.deepEqual(
  [12, 12, 12, 12].map((delta, i) => steps.consume(delta, i * 16)),
  [0, 0, 0, 1],
  "Small touchpad deltas accumulate into one album instead of one album per event",
);
assert.equal(
  steps.consume(144, 80),
  3,
  "A fast gesture can advance several albums",
);
assert.equal(steps.consume(10000, 96), 3, "Oversized events are bounded");
assert.equal(
  steps.consume(1, 112),
  0,
  "No backlog remains after an oversized event",
);
steps.reset();
assert.equal(steps.consume(40, 0), 0);
assert.equal(steps.consume(-40, 16), 0);
assert.equal(
  steps.consume(-8, 32),
  -1,
  "Reversing a gesture never consumes the forward remainder",
);
steps.reset();
assert.equal(steps.consume(40, 0), 0);
assert.equal(
  steps.consume(8, 300),
  0,
  "Separate gestures do not inherit partial movement",
);

// Exercise event ownership without a WebGL renderer. Native control and pane
// scrolling must remain untouched even when the archive behind them is ready.
class FakeElement extends EventTarget {
  constructor({
    native = false,
    scrollHeight = 800,
    clientHeight = 800,
    overflowY = "visible",
    parentElement = null,
  } = {}) {
    super();
    Object.assign(this, {
      native,
      scrollHeight,
      clientHeight,
      overflowY,
      parentElement,
    });
  }
  closest() {
    return this.native ? this : null;
  }
}
globalThis.Element = FakeElement;
globalThis.window = new EventTarget();
globalThis.getComputedStyle = (element) => ({ overflowY: element.overflowY });
const stage = new FakeElement();
const canvas = new FakeElement({ parentElement: stage });
let enabled = true;
let lane = 0;
const moves = [];
const controller = mountMusicWheelNavigation(stage, {
  enabled: () => enabled,
  context: () => lane,
  navigate: (direction) => moves.push(direction),
});
function dispatch(deltaY, target = canvas, overrides = {}) {
  const event = new Event("wheel", { cancelable: true });
  Object.assign(event, input(deltaY, overrides));
  Object.defineProperty(event, "target", { value: target });
  stage.dispatchEvent(event);
  return event;
}
assert.equal(dispatch(48).defaultPrevented, true);
assert.deepEqual(moves, [1]);
assert.equal(dispatch(48, canvas, { ctrlKey: true }).defaultPrevented, false);
assert.equal(
  dispatch(48, new FakeElement({ native: true, parentElement: stage }))
    .defaultPrevented,
  false,
  "Inputs, developer panels, dialogs, and detail content keep native wheel ownership",
);
assert.equal(
  dispatch(
    48,
    new FakeElement({
      scrollHeight: 1000,
      overflowY: "auto",
      parentElement: stage,
    }),
  ).defaultPrevented,
  false,
  "Scrollable content keeps native scrolling, including at its boundary",
);
enabled = false;
assert.equal(
  dispatch(48).defaultPrevented,
  false,
  "Intro, details, loading, and modal panels can disable archive wheel input",
);
enabled = true;
dispatch(40);
lane = 1;
dispatch(8);
assert.deepEqual(
  moves,
  [1],
  "Partial wheel gestures do not follow the user into a new singer column",
);
dispatch(40);
assert.deepEqual(moves, [1, 1]);
dispatch(40);
stage.dispatchEvent(new Event("keydown"));
dispatch(8);
assert.deepEqual(
  moves,
  [1, 1],
  "Keyboard and pointer navigation cancel partial wheel gestures",
);
controller.dispose();
assert.equal(
  dispatch(48).defaultPrevented,
  false,
  "Disposing removes the non-passive wheel listener",
);
console.log(
  "Music wheel navigation passed: pixel/line/page units, trackpad accumulation, fast input, reversal, column isolation, native scroll and zoom ownership.",
);
