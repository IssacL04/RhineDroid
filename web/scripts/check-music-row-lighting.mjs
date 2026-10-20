import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
import { ROW_LIGHTING, DEFAULT_ROW_LIGHTING, normalizeRowLighting, sampleRowLighting, ROW_LIGHTING_GLSL } from '../src/music-row-lighting.ts';

function sourceModule(path, overrides = {}) {
  const url = new URL(path, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const code = outputText.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) =>
    `from ${JSON.stringify(overrides[specifier] ?? (specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier)))}`);
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
}
const { MusicSelectionLighting } = await import(sourceModule('../src/music-lighting.ts', {
  './theme-transition.ts': sourceModule('../src/theme-transition.ts'),
}));
const { ThemeTransition } = await import(sourceModule('../src/theme-transition.ts'));

// Execute the actual scalar GLSL field expression, not merely a separately
// restated JS approximation. Real WebGL shader compilation is browser-verified.
const body = ROW_LIGHTING_GLSL.match(/float musicRowField\(vec3 origin, vec3 column\) \{([\s\S]*?)\n  \}/)[1];
const glslField = new Function('origin', 'column', 'musicRowSettings',
  `const exp = Math.exp; ${body.replace(/\bfloat\b/g, 'const')}`);
const uniforms = (settings) => new THREE.Vector4(ROW_LIGHTING.modes[settings.mode], settings.strength, settings.width, settings.offset);
const sample = (dx, dz, settings = DEFAULT_ROW_LIGHTING) =>
  glslField(new THREE.Vector3(dx, 0, dz), new THREE.Vector3(), uniforms(settings));

assert.equal(sample(0, 0), 1, 'The intended row is the peak, not the selected lane alone');
assert.ok(Math.abs(sample(0, ROW_LIGHTING.rowSpacing) - 1 / 16) < 1e-12,
  'At a one-row FWHM, the next row receives 1/16 of the core field');
assert.ok(sample(2 * ROW_LIGHTING.laneSpacing, 0) > 0.996,
  'Five neighboring lanes share an almost uniform illuminated row');
assert.ok(sample(3 * ROW_LIGHTING.laneSpacing, 0) > 0.96,
  'The ribbon remains continuous across seven lanes');
assert.ok(sample(0, 2 * ROW_LIGHTING.rowSpacing) < 0.00002,
  'Two rows away has no visually meaningful synthetic highlight');
for (const width of [0.6, 1, 2.5]) for (const offset of [-6, -1.5, 0, 6]) {
  const settings = { ...DEFAULT_ROW_LIGHTING, width, offset };
  const center = offset * ROW_LIGHTING.rowSpacing;
  assert.ok(Math.abs(sample(0, center, settings) - 1) < 1e-12, 'Offset is in physical row units');
  assert.ok(Math.abs(sample(0, center + 0.5 * width * ROW_LIGHTING.rowSpacing, settings) - 0.5) < 1e-12,
    'Width control is the measurable full width at half maximum');
  for (const dx of [-18, -5.2, 0, 5.2, 18]) for (const dz of [-2, -0.31, 0, 0.31, 2])
    assert.ok(Math.abs(sample(dx, dz, settings) - sampleRowLighting(dx, dz, settings)) < 1e-12,
      'Published sampler matches the production shader at multiple widths and offsets');
}

function setup() {
  const scene = new THREE.Scene();
  const model = new THREE.Group(); scene.add(model);
  const camera = new THREE.PerspectiveCamera(); camera.position.set(-62,36,43); camera.lookAt(0,0,0);
  const light = new MusicSelectionLighting(scene);
  const shell = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  const print = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  light.shade(shell, 'Frosted_Polymer');
  light.shadePrint(print);
  light.update(model, camera, 0, true, true);
  return { scene, model, camera, light, shell, print };
}
const a = setup();
assert.deepEqual(a.light.getExperiment(), DEFAULT_ROW_LIGHTING, 'An unconfigured controller remains V0.3.0 baseline');
assert.equal(a.light.area.intensity, 0, 'Baseline adds no real light energy');
assert.equal(a.print.uniforms.musicRowSettings, a.shell.uniforms.musicRowSettings, 'Print and shell controls share one uniform');
assert.equal(a.print.uniforms.musicPrintLightColumn, a.shell.uniforms.musicLightColumn, 'Print and shell have the same world-space anchor');
const originalShellSource = a.shell.fragmentShader;
const originalPrintSource = a.print.fragmentShader;
const originalUniform = a.shell.uniforms.musicRowSettings;
const originalObjects = a.scene.children.slice();
for (const mode of ['area', 'guided', 'hybrid', 'baseline']) {
  a.light.setExperiment({ mode, strength: 1, width: 1, offset: 0 });
  a.light.update(a.model, a.camera, 1 / 60, true, false);
  assert.equal(originalUniform.value.x, ROW_LIGHTING.modes[mode], 'A mode switch updates existing uniforms');
  assert.equal(a.shell.fragmentShader, originalShellSource, 'Mode switching does not rebuild shell shaders');
  assert.equal(a.print.fragmentShader, originalPrintSource, 'Mode switching does not rebuild print shaders');
  assert.deepEqual(a.scene.children, originalObjects, 'Mode switching adds no geometry or scene objects');
  assert.equal(a.light.area.visible, true, 'Light enumeration stays stable while switching modes');
  assert.equal(a.light.spot.visible, true);
  assert.equal(a.light.area.intensity > 0, mode === 'area' || mode === 'hybrid');
}
assert.equal(a.light.area.castShadow, false, 'RectAreaLight introduces no shadow-map render');
assert.ok(a.light.area.width / a.light.area.height > 200, 'Physical emitter is a horizontal strip');
assert.equal(a.scene.children.filter(o => o.isMesh).length, 0, 'Lighting adds no draw-call geometry');

// Execute the production print exposure block. This checks the final exposure
// contrast, including the readable ambient floor, not only Gaussian ratios.
const printBody = a.print.fragmentShader.match(/float ambient =([\s\S]*?)\/\/ A lifted CD/)[0].split('// A lifted CD')[0];
const printExposure = new Function('musicPrintAmbient', 'musicRowSettings', 'rowField', 'musicRowFill = 1', 'printLight = 0', `
  const max = Math.max;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const mix = (a, b, t) => a + (b - a) * t;
  ${printBody.replace(/\bfloat\b/g, 'const')}
  return shelfExposure;
`);
for (const ambient of [0.5, 0.38, 0.12]) {
  const guided = uniforms({ ...DEFAULT_ROW_LIGHTING, mode: 'guided' });
  const center = printExposure(ambient, guided, sample(0, 0), 0);
  const neighbor = printExposure(ambient, guided, sample(0, ROW_LIGHTING.rowSpacing), 0);
  assert.equal(center, 1, 'Core never exceeds the incoming diffuse ink color');
  assert.ok(center / neighbor > 3.3, 'Fill zero preserves the initial high-contrast experiment');
  assert.ok(neighbor >= 0.08, 'Unlit rows retain a nonzero fraction of their real diffuse detail');
  for (const spatialLight of [0, 0.25, 0.75, 1]) {
    const reference = ambient + (1 - ambient) * spatialLight;
    assert.ok(Math.abs(printExposure(ambient, guided, 0, 1, spatialLight) - reference) < 1e-12,
      'At fill 1, unlit B covers recover the actual original spatial exposure');
    const dark = printExposure(ambient, guided, 0, 0, spatialLight);
    const half = printExposure(ambient, guided, 0, 0.5, spatialLight);
    assert.ok(dark <= half && half <= reference, 'Fill raises unlit covers continuously toward the original');
    assert.equal(printExposure(ambient, guided, 1, 1, spatialLight), 1, 'Restoring neighbors leaves the core unchanged');
    const hybrid = uniforms({ ...DEFAULT_ROW_LIGHTING, mode: 'hybrid' });
    assert.equal(printExposure(ambient, hybrid, 0.3, 0, spatialLight), printExposure(ambient, hybrid, 0.3, 1, spatialLight),
      'C retains its original exposure when B fill changes');
  }
  const area = uniforms({ ...DEFAULT_ROW_LIGHTING, mode: 'area' });
  assert.equal(printExposure(ambient, area, 1), printExposure(ambient, area, 0),
    'Physical-only mode does not secretly synthesize a print ribbon');
}

// Evaluate the production shell exposure as well as the cover path.
const shellBody = a.shell.fragmentShader.match(/float fillAmount =([\s\S]*?)outgoingLight \*= shelfExposure;/)[0].split('outgoingLight *=')[0];
const shellExposure = new Function('musicRowSettings', 'musicRowFill', 'guidedLight', 'rowGain', `
  const mix = (a, b, t) => a + (b - a) * t;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  ${shellBody.replace(/\bfloat\b/g, 'const')}
  return shelfExposure;
`);
for (const localLight of [0, 0.5, 1]) {
  const settings = uniforms({ ...DEFAULT_ROW_LIGHTING, mode: 'guided' });
  assert.equal(shellExposure(settings, 0, localLight, 0), 0.56);
  assert.equal(shellExposure(settings, 1, localLight, 0), 0.96 + 0.08 * localLight,
    'Unlit B shells restore original diffuse exposure at default fill');
  assert.equal(shellExposure(settings, 1, localLight, 1), 1.08, 'Core shell exposure is preserved');
}
assert.equal(a.print.uniforms.musicRowFill, a.shell.uniforms.musicRowFill, 'Fill updates shell and art through the same uniform');
a.light.setExperiment({fill: -4}); assert.equal(a.light.getExperiment().fill, 0);
a.light.setExperiment({fill: 4}); assert.equal(a.light.getExperiment().fill, 1);
a.light.setExperiment({transitionDuration: 0}); assert.equal(a.light.getExperiment().transitionDuration, 0.4);
a.light.setExperiment({transitionDuration: 10}); assert.equal(a.light.getExperiment().transitionDuration, 2.4);
a.light.setExperiment({transitionDuration: NaN}); assert.equal(a.light.getExperiment().transitionDuration, 2.4);
a.light.setExperiment({transitionDuration: DEFAULT_ROW_LIGHTING.transitionDuration});

const b = setup();
a.light.setExperiment({ mode: 'guided' }); b.light.setExperiment({ mode: 'guided' });
a.light.update(a.model, a.camera, 0, true, false);
b.light.update(b.model, b.camera, 0, true, false);
a.model.position.z = b.model.position.z = 0.62;
a.light.update(a.model, a.camera, 0.1, true, false);
for (let i = 0; i < 12; i++) b.light.update(b.model, b.camera, 1 / 120, true, false);
const aColumn = a.shell.uniforms.musicRowColumn.value;
const bColumn = b.shell.uniforms.musicRowColumn.value;
assert.ok(aColumn.distanceTo(bColumn) < 1e-12, 'Row following remains frame-rate independent');
assert.ok(aColumn.z > 0 && aColumn.z < 0.62, 'Row changes start continuously');
const before = aColumn.clone();
a.model.position.z = -0.62;
a.light.update(a.model, a.camera, 1 / 60, true, false);
assert.ok(aColumn.z < before.z && aColumn.z > -0.62, 'Rapid row reversal turns immediately without overshooting');
a.light.update(a.model, a.camera, 0, true, true);
assert.equal(aColumn.z, -0.62, 'Reduced motion anchors immediately');

// Parent transforms are real world-space inputs in experimental modes. Moving
// the model to another owner with its world transform preserved changes no field.
const parent = new THREE.Group(); parent.position.set(11, 2, 4); a.scene.add(parent);
parent.attach(a.model);
a.light.update(a.model, a.camera, 0, true, true);
assert.ok(aColumn.distanceTo(a.model.getWorldPosition(new THREE.Vector3())) < 1e-12);
const movedWorld = a.model.getWorldPosition(new THREE.Vector3());
const instanceMatrix = new THREE.Matrix4().makeTranslation(movedWorld.x, movedWorld.y, movedWorld.z);
const instanceOrigin = new THREE.Vector3().applyMatrix4(instanceMatrix);
assert.equal(glslField(instanceOrigin, aColumn, originalUniform.value),
  glslField(movedWorld, aColumn, originalUniform.value), 'Instance/extracted ownership gives identical row exposure');
const liftedOrigin = movedWorld.clone().add(new THREE.Vector3(0, 6, 0));
assert.equal(glslField(liftedOrigin, aColumn, originalUniform.value), 1, 'Lifting does not leave the row field');

a.light.setExperiment({ mode: 'hybrid', strength: 2, width: 2.5, offset: 6 });
const snapshot = a.light.getExperiment(); snapshot.width = 100;
assert.equal(a.light.getExperiment().width, 2.5, 'Diagnostics cannot mutate live controls');
a.light.setExperiment({ strength: -5, width: 99, offset: -99 });
assert.deepEqual(a.light.getExperiment(), { mode: 'hybrid', strength: 0, width: 2.5, offset: -6, fill: 1, transitionDuration: 1.2 });
assert.equal(a.light.area.intensity, 0, 'Strength zero extinguishes the physical contribution');
assert.deepEqual(normalizeRowLighting({ width: NaN, strength: Infinity, offset: NaN, mode: 'bad' }), DEFAULT_ROW_LIGHTING,
  'Nonfinite and invalid settings never reach shader uniforms');

a.light.setExperiment({ mode: 'area', strength: 1, width: 1, offset: 0 });
const key = new THREE.DirectionalLight();
const transition = new ThemeTransition(0);
a.light.setTheme('night', key, transition); transition.finish();
a.light.update(a.model, a.camera, 0, true, true);
assert.equal(a.light.area.intensity, 24, 'Theme transition controls physical strip energy');
assert.equal(a.light.area.color.getHex(), new THREE.Color('#dbe9ff').getHex());
a.light.update(a.model, a.camera, 0, true, true, false, 0.5);
assert.equal(a.shell.uniforms.musicRowDetail.value, 0.5, 'Detail handoff is continuous');
assert.equal(a.light.area.intensity, 12, 'Physical strip fades while detail lighting takes over');
a.light.update(a.model, a.camera, 0, true, true, false, 1);
assert.equal(a.light.area.intensity, 0, 'Full detail uses the established inspection lighting');
assert.equal(a.shell.uniforms.musicRowDetail.value, 1);
a.light.update(a.model, a.camera, 0, false, false);
assert.equal(a.light.spot.visible, false);
assert.equal(a.light.area.visible, false, 'Empty/hidden shelves disable both real lights');

console.log('V0.3.1 row lighting passed: exact FWHM/offset units, seven-lane continuity, 16× adjacent-row field contrast, original-calibrated B fill, unchanged core and A/C exposure, continuous fill controls, same-world ownership/elevation, frame-rate-independent follow/reversal, uniform-only switching, stable light list, no added geometry/shadow pass, reduced motion, theme/detail handoff and input bounds. GPU output and performance require the separate browser review.');
