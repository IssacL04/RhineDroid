import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { glassRevealAtHeight as reveal } from "../src/glass-reveal.ts";
import { decryptionFrame } from "../src/decryption.ts";
async function load(path) {
  const b = await readFile(new URL(path, import.meta.url));
  const s = (
    await new GLTFLoader().parseAsync(
      b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
      "",
    )
  ).scene;
  s.updateMatrixWorld(true);
  return s;
}
// Subsequent ring changes are covered by check-internal-optics.mjs.
const after = await load("../public/assets/archive-assembly.glb");
let patch,
  metal,
  engravingDepth = -Infinity;
after.traverse((m) => {
  if (!m.isMesh) return;
  const name = m.material.name.replace(/\.\d+$/, "");
  assert.notEqual(name, "Amber_Lightguide");
  const box = new T.Box3().setFromObject(m);
  if (name === "Index_Inlay") patch = box;
  if (name === "Titanium_Fasteners") metal = m;
  if (name.startsWith("Case_") && m.userData.assemblyPart === "cover")
    engravingDepth = Math.max(engravingDepth, box.max.z);
});
assert.ok(patch && metal);
assert.ok(Math.abs(patch.max.y - 3.7) < 1e-5, "Patch flush with top");
assert.ok(Math.abs(patch.max.z - 0.206) < 1e-5, "Patch flush with front");
assert.ok(Math.abs(patch.max.x - patch.min.x - 0.25) < 1e-5);
assert.ok(
  engravingDepth < 0.174,
  "Every frame/boss engraving lies behind front cover",
);
const positions = metal.geometry.attributes.position;
let tr = 0,
  bl = 0;
for (let i = 0; i < positions.count; i++) {
  const v = new T.Vector3()
    .fromBufferAttribute(positions, i)
    .applyMatrix4(metal.matrixWorld);
  if (v.x > 2.25 && v.y > 3.4) tr++;
  else if (v.x < -2.2 && v.y < 0.23) bl++;
  else assert.fail("Extra screw outside top-right / bottom-left");
}
assert.ok(tr > 0 && bl > 0);
for (let h = 0; h <= 1; h += 0.01) {
  assert.equal(reveal(0, h), 0);
  assert.equal(reveal(1, h), 1);
  let last = 0;
  for (let p = 0; p <= 1; p += 0.01) {
    const next = reveal(p, h);
    assert.ok(next >= last);
    last = next;
  }
}
assert.equal(reveal(0.5, 0.9), 1);
assert.equal(reveal(0.5, 0.1), 0);
let last = 0;
for (let t = 38.84; t <= 39.56; t += 0.001) {
  const p = decryptionFrame(t).clarity;
  assert.ok(p >= last);
  last = p;
}
assert.equal(decryptionFrame(38.84).clarity, 0);
assert.equal(decryptionFrame(39.56).clarity, 1);
console.log(
  JSON.stringify(
    {
      passed: true,
      screwRegions: 2,
      patchSize: patch.getSize(new T.Vector3()).toArray(),
      engravingDepth,
      reveal: "fully frosted → top to bottom → fully clear",
    },
    null,
    2,
  ),
);
