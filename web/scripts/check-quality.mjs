import assert from "node:assert/strict";
import {
  normalizeQuality,
  qualityPresets,
  matchingPreset,
  renderDimensions,
} from "../src/render-quality.ts";

assert.deepEqual(normalizeQuality(null), qualityPresets.original);
const legacy = normalizeQuality(undefined, false);
assert.equal(legacy.pixelRatio, 1);
assert.equal(legacy.aoSamples, 0);
assert.equal(legacy.depthOfField, 0);
assert.equal(legacy.shadows, 2048, "Migration preserves old low-mode shadows");
assert.equal(legacy.transmission, 1, "Migration preserves old low-mode glass");
for (const bad of [
  null,
  false,
  "ultra",
  [],
  {
    scale: NaN,
    pixelRatio: 99,
    antialias: "injected",
    shadows: -1,
    aoSamples: Infinity,
  },
]) {
  assert.deepEqual(normalizeQuality(bad), qualityPresets.original);
}
assert.equal(normalizeQuality({ scale: 99999 }).scale, 200);
assert.equal(normalizeQuality({ scale: -1 }).scale, 50);
assert.equal(normalizeQuality({ depthOfField: 99999 }).depthOfField, 150);
for (const [name, quality] of Object.entries(qualityPresets)) {
  assert.equal(matchingPreset(normalizeQuality(quality)), name);
  const reloaded = normalizeQuality(JSON.parse(JSON.stringify(quality)));
  assert.deepEqual(reloaded, quality);
}
assert.equal(matchingPreset({ ...qualityPresets.ultra, scale: 145 }), "custom");
for (const width of [640, 1920, 3840, 7680]) {
  for (const dpr of [1, 1.5, 2, 3]) {
    for (const max of [2048, 4096, 16384]) {
      const dimensions = renderDimensions(
        normalizeQuality({ scale: 200, pixelRatio: 3 }),
        1920,
        1080,
        width / 1920,
        dpr,
        max,
      );
      assert.ok(dimensions.width * dimensions.height <= 8_294_400);
      assert.ok(dimensions.width <= max && dimensions.height <= max);
      assert.ok(dimensions.ratio > 0);
    }
  }
}
const native = renderDimensions(
  qualityPresets.original,
  1920,
  1080,
  1,
  1,
  16384,
);
const ultra = renderDimensions(qualityPresets.ultra, 1920, 1080, 1, 1, 16384);
assert.equal(native.width, 1920);
assert.equal(ultra.width, 2880);
assert.equal(
  (ultra.width * ultra.height) / (native.width * native.height),
  2.25,
);
assert.equal(
  renderDimensions(qualityPresets.ultra, 1920, 1080, 2, 2, 16384).limited,
  true,
);
console.log(
  "Quality checks passed: migration, invalid storage, presets, supersampling and 48 device-limit combinations.",
);
