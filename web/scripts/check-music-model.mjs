import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mock } from "node:test";
import ts from "typescript";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MUSIC_MODEL, MUSIC_COVER, MUSIC_CASE_LAYERS, normalizeMusicGeometry, configureMusicGlass, createAlbumPrintMaterial, shadeMusicGlass } from "../src/music-model.ts";
import { MUSIC_CD_ASSET } from "../src/music-cd-asset.ts";

// Match the existing presentation/lighting checks: transpile production code
// with parameter properties, then resolve its imports from the original file.
async function sourceModule(path, overrides = {}) {
  const url = new URL(path, import.meta.url);
  const { outputText } = ts.transpileModule(await fs.readFile(url, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const code = outputText.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) =>
    `from ${JSON.stringify(overrides[specifier] ?? (specifier.startsWith(".") ? new URL(specifier, url).href : import.meta.resolve(specifier)))}`);
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}
const transitionUrl = await sourceModule("../src/theme-transition.ts");
const { ThemeTransition } = await import(transitionUrl);
const { CardAppearance } = await import(await sourceModule("../src/appearance.ts", {
  "./theme-transition.ts": transitionUrl,
}));

const bytes = await fs.readFile(new URL(`../public/${MUSIC_CD_ASSET.split("?")[0]}`, import.meta.url));
const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
gltf.scene.updateMatrixWorld(true);
const surfaces = [];
const appearance = new CardAppearance();
const appearanceModel = new THREE.Group();
const baseline = new Map();
const geometryBounds = new Map();
let triangles = 0;
gltf.scene.traverse((object) => {
  if (!(object instanceof THREE.Mesh)) return;
  const surface = object.material.name;
  surfaces.push(surface);
  normalizeMusicGeometry(object.geometry);
  geometryBounds.set(surface, object.geometry.boundingBox.clone());
  triangles += object.geometry.index.count / 3;
  const once = [...object.geometry.attributes.position.array];
  normalizeMusicGeometry(object.geometry);
  assert.deepEqual([...object.geometry.attributes.position.array], once, "normalisation must never compound");
  const material = new THREE.MeshPhysicalMaterial();
  configureMusicGlass(surface, material);
  assert.equal(material.side, THREE.FrontSide,
    "finish tuning preserves the single-sided transmission path and avoids capturing the shell over its own insert");
  assert.ok(material.transmission >= 0.6, `${surface} remains glass`);
  const [minimum, maximum] = surface === "Ivory_Edges" ? [0.24, 0.3] : [0.32, 0.4];
  assert.ok(material.roughness >= minimum && material.roughness <= maximum, `${surface} retains the reference's soft frosted finish`);
  assert.ok(material.clearcoat <= 0.18, `${surface} avoids a polished plastic coat`);
  baseline.set(surface, {
    transmission: material.transmission,
    thickness: material.thickness,
    attenuationDistance: material.attenuationDistance,
  });
  appearance.register(surface, material, material.clone());
  const appearanceMesh = new THREE.Mesh(object.geometry, material);
  appearanceMesh.userData.surface = surface;
  appearanceMesh.userData.musicShell = true;
  appearanceModel.add(appearanceMesh);
});
assert.deepEqual(surfaces.sort(), ["Frosted_Polymer", "Ivory_Edges", "Optical_Diffuser"].sort(), "music model contains only shell, frame and backing; no rings or screws");
const bounds = new THREE.Box3().setFromObject(gltf.scene);
const size = bounds.getSize(new THREE.Vector3());
for (const [axis, dimension] of [["x", "width"], ["y", "height"], ["z", "depth"]])
  assert.ok(Math.abs(size[axis] - MUSIC_MODEL[dimension]) < 1e-6, `actual GLB ${dimension} matches the camera dimensions`);
assert.ok(Math.abs(bounds.getCenter(new THREE.Vector3()).y - MUSIC_MODEL.center.y) < 1e-6);
assert.ok(triangles <= 1200, "new construction stays below the shelf geometry budget");
assert.equal(gltf.scene.children[0].userData.version, "0.4.0", "runtime loads the reconstructed native-size case");
assert.ok(MUSIC_COVER.z < geometryBounds.get("Frosted_Polymer").min.z - 0.02, "paper sits behind the front lid with a real air gap");
assert.ok(MUSIC_COVER.z > MUSIC_CASE_LAYERS.rearFront + 0.04, "paper sits ahead of the rear tray");
assert.ok(MUSIC_COVER.x - MUSIC_COVER.width / 2 > MUSIC_CASE_LAYERS.spineRight + 0.4, "cover leaves the high-frost spine unobstructed");
assert.ok(geometryBounds.get("Ivory_Edges").max.x < MUSIC_COVER.x - MUSIC_COVER.width / 2, "high-frost strip never covers artwork");
assert.ok(MUSIC_COVER.x - MUSIC_COVER.width / 2 > bounds.min.x);
assert.ok(MUSIC_COVER.x + MUSIC_COVER.width / 2 < bounds.max.x);
assert.ok(MUSIC_COVER.y - MUSIC_COVER.height / 2 > bounds.min.y);
assert.ok(MUSIC_COVER.y + MUSIC_COVER.height / 2 < bounds.max.y);
const print = createAlbumPrintMaterial(new THREE.Texture());
assert.equal(print.isMeshLambertMaterial, true);
assert.equal(print.toneMapped, false);
assert.equal(print.fog, true);
assert.equal(print.transparent, false);
assert.equal(print.emissive.getHex(), 0, "Artwork emits no light of its own");
appearance.prepare(appearanceModel);
const printedCover = new THREE.Mesh(new THREE.PlaneGeometry(MUSIC_COVER.width, MUSIC_COVER.height), print);
printedCover.userData.albumCover = true;
appearanceModel.add(printedCover);
const printBefore = JSON.stringify(print.toJSON());
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-12, message);
const materialFields = ["transmission", "thickness", "roughness", "attenuationDistance"];
const artworkUnchanged = () => {
  assert.equal(printedCover.material, print, "Appearance never replaces the separate artwork material");
  assert.equal(JSON.stringify(print.toJSON()), printBefore, "Frosting, selection quality and themes do not mutate the artwork material");
};
const renderState = (quality, clarity) => {
  appearance.apply(appearanceModel, quality);
  appearance.setClarity(appearanceModel, clarity);
  artworkUnchanged();
  return new Map(appearanceModel.children.filter(child => child.userData.musicShell).map(child => [
    child.userData.surface,
    {
      ...Object.fromEntries(materialFields.map(field => [field, child.material[field]])),
      color: child.material.color.toArray(),
      attenuationColor: child.material.attenuationColor.toArray(),
    },
  ]));
};
const assertState = (actual, expected, message) => {
  for (const [surface, state] of actual) {
    const target = expected.get(surface);
    for (const field of materialFields) close(state[field], target[field], `${message}: ${surface} ${field}`);
    for (const field of ["color", "attenuationColor"])
      state[field].forEach((channel, i) => close(channel, target[field][i], `${message}: ${surface} ${field}[${i}]`));
  }
};
// Exercise the actual main-scene/viewer appearance path. Its final clarity
// update must retain frosting after selection quality and theme changes.
const settled = new Map();
for (const theme of ["day", "night", "dusk", "day", "dusk", "night", "day"]) {
  appearance.setTheme(theme);
  for (const quality of [0, 0.5, 1]) for (const clarity of [0, 0.5, 1]) {
    const state = renderState(quality, clarity);
    const glass = state.get("Frosted_Polymer");
    const [minimum, maximum] = theme === "day" ? [0.33, 0.41] : [0.26, 0.35];
    assert.ok(glass.roughness >= minimum && glass.roughness <= maximum, `${theme} retains its frosted finish after each clarity update`);
    if (clarity === 1 && theme !== "day")
      assert.ok(glass.roughness >= 0.26 && glass.roughness <= 0.28, "Night/dusk inspection keeps the new thin lid lightly frosted");
    const spine = state.get("Ivory_Edges");
    assert.ok(spine.roughness >= 0.24 && spine.roughness <= 0.31, "spine preserves blurred background bands instead of averaging them into a flat strip");
    assert.ok(spine.thickness > glass.thickness * 2 && spine.transmission < glass.transmission, "spine density comes from its optical depth while the lid stays light");
    assert.ok(spine.transmission >= 0.84, "spine stays translucent rather than reading as a solid white strip");
    for (const [surface, material] of state) {
      const original = baseline.get(surface);
      assert.ok(material.transmission > 0.5 && material.transmission < 1, `${theme} ${surface} stays transmissive glass`);
      if (theme === "day") {
        assert.ok(material.transmission < original.transmission, `${surface} has more body against the pale daytime background`);
        assert.ok(material.thickness > original.thickness, `${surface} gains visible daytime volume`);
        assert.ok(material.attenuationDistance < original.attenuationDistance, `${surface} gains daytime edge density`);
      } else {
        for (const field of Object.keys(original))
          close(material[field], original[field], `${theme} restores ${surface} ${field} after leaving day`);
      }
    }
    const key = `${theme}:${clarity}`;
    if (settled.has(key)) assertState(state, settled.get(key), "Theme round trips and selection quality preserve settled materials");
    else settled.set(key, state);
  }
}
for (const clarity of [0, 0.5, 1]) {
  const day = settled.get(`day:${clarity}`).get("Frosted_Polymer");
  const night = settled.get(`night:${clarity}`).get("Frosted_Polymer");
  assert.ok(day.roughness > night.roughness, "Daytime frosting remains stronger throughout the clarity animation");
}

// Drive the real 650 ms transition on a deterministic clock. Registering the
// base palette and daytime tint against one Color must neither jump nor lose
// the final target when the later registration replaces the earlier one.
let nowSeconds = 0;
const clock = mock.method(performance, "now", () => nowSeconds * 1000);
try {
  for (const [from, to] of [
    ["day", "night"], ["night", "day"], ["day", "dusk"],
    ["dusk", "day"], ["night", "dusk"], ["dusk", "night"],
  ]) {
    appearance.setTheme(from);
    nowSeconds = 0;
    const transition = new ThemeTransition();
    appearance.setTheme(to, transition);
    assertState(renderState(1, 1), settled.get(`${from}:1`), "Scheduling a theme transition does not alter the displayed material");
    for (const [frame, elapsed] of [0, 0.016, 0.065, 0.1625, 0.325, 0.4875, 0.634, 0.65].entries()) {
      nowSeconds = elapsed;
      assert.equal(transition.update(nowSeconds), elapsed === 0.65, "The theme transition finishes at 650 ms");
      const clarity = [0, 0.5, 1][frame % 3];
      const state = renderState([1, 0.5, 0][frame % 3], clarity);
      const start = settled.get(`${from}:${clarity}`);
      const finish = settled.get(`${to}:${clarity}`);
      for (const [surface, material] of state) {
        const source = start.get(surface), target = finish.get(surface);
        const between = (actual, a, b, field) => {
          assert.ok(actual >= Math.min(a, b) - 1e-12 && actual <= Math.max(a, b) + 1e-12,
            `${from} → ${to}: ${surface} ${field} stays within its theme endpoints`);
          if (elapsed === 0.325 && Math.abs(a - b) > 1e-9)
            assert.ok(actual > Math.min(a, b) && actual < Math.max(a, b), `${field} has an intermediate value halfway through the transition`);
        };
        for (const field of materialFields) between(material[field], source[field], target[field], field);
        for (const field of ["color", "attenuationColor"])
          material[field].forEach((value, i) => between(value, source[field][i], target[field][i], `${field}[${i}]`));
      }
      if (elapsed === 0) assertState(state, start, "The first frame retains the previous theme");
      if (elapsed === 0.65) assertState(state, finish, "The last frame reaches the requested theme");
    }
  }
} finally {
  clock.mock.restore();
}
const shader = {
  vertexShader: THREE.ShaderLib.physical.vertexShader,
  fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  uniforms: {},
};
shadeMusicGlass(shader, "Frosted_Polymer");
assert.ok(shader.fragmentShader.includes("musicThinLid"));
assert.ok(shader.fragmentShader.includes("mix(1.0, 0.04, paperProximity)"), "nearby paper retains its small footprint while the uncovered margin diffuses the background");
assert.ok(shader.vertexShader.includes("vMusicLidPosition = position.xy"), "frost coordinates follow the geometry through instancing, extraction and rotation");
const compiledOnce = { vertex: shader.vertexShader, fragment: shader.fragmentShader };
shadeMusicGlass(shader, "Frosted_Polymer");
assert.deepEqual({ vertex: shader.vertexShader, fragment: shader.fragmentShader }, compiledOnce, "shader composition is idempotent");
const preparedLid = appearanceModel.children.find(child => child.userData.surface === "Frosted_Polymer").material;
const preparedShader = {
  vertexShader: THREE.ShaderLib.physical.vertexShader,
  fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  uniforms: {},
};
preparedLid.onBeforeCompile(preparedShader, {});
assert.ok(preparedShader.fragmentShader.includes("mix(1.0, 0.04, paperProximity)"), "prepared selection/returning/viewer materials retain the same spatial frosting as the shelf");
assert.ok(!preparedShader.fragmentShader.includes("archiveTransmissionLod"), "legacy full-panel frosting cannot override the protected paper footprint");
const spineShader = { fragmentShader: "#include <transmission_pars_fragment>", uniforms: {} };
shadeMusicGlass(spineShader, "Ivory_Edges");
assert.equal(spineShader.fragmentShader, "#include <transmission_pars_fragment>", "spine retains the wider diffuse transmission footprint");
console.log(`Music case V0.4.0 passed: new ${triangles}-triangle/3-batch GLB, native dimensions, recessed insert, high-frost spine, thin-lid optics, and continuous theme/clarity round trips.`);
