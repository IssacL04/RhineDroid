import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { COLUMN_SPACING, ROW_SPACING, LOOP_COLUMNS, LOOP_ROWS, visibleCell } from '../src/archive-loop.ts';
import { MUSIC_MODEL, normalizeMusicGeometry, createAlbumPrintMaterial } from '../src/music-model.ts';
import { MUSIC_CD_ASSET } from '../src/music-cd-asset.ts';

// Resolve every production import, including the shared theme transition.
// Both classes use parameter properties that require transpilation for Node.
function sourceModule(path, overrides = {}) {
  const url = new URL(path, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(url, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const code = outputText.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) =>
    `from ${JSON.stringify(overrides[specifier] ?? (specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier)))}`);
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
}
const transitionUrl = sourceModule('../src/theme-transition.ts');
const { MusicSelectionLighting } = await import(sourceModule('../src/music-lighting.ts', {
  './theme-transition.ts': transitionUrl,
}));
function setup() {
  const light = new MusicSelectionLighting(new THREE.Scene());
  const model = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(); camera.position.set(-62,36,43); camera.lookAt(0,0,0);
  light.update(model,camera,0,true,true);
  const shader = {uniforms:{},vertexShader:'#include <begin_vertex>',fragmentShader:'#include <opaque_fragment>'};
  light.shade(shader,'Frosted_Polymer');
  return {light,model,camera,shader,column:shader.uniforms.musicLightColumn.value};
}
const a=setup(), b=setup();
a.model.position.x=b.model.position.x=5.2;
a.light.update(a.model,a.camera,.1,true,false);
assert.ok(a.column.x>0 && a.column.x<.5,'Light begins gradually with the lift');
for(let i=0;i<12;i++)b.light.update(b.model,b.camera,1/120,true,false);
assert.ok(a.column.distanceTo(b.column)<1e-9,'Light transition is independent of frame rate');
const before=a.column.clone();
a.model.position.x=-5.2;
a.light.update(a.model,a.camera,1/60,true,false);
assert.ok(a.column.distanceTo(before)<.2,'Rapid reversal preserves position and velocity continuity');
a.light.update(a.model,a.camera,0,true,true);
assert.equal(a.column.x,-5.2,'Reduced motion snaps to the selected location');
// Use the actual shell bounds and complete instance pool, including its hidden
// margins. A source inside this volume can burn a corner even when the selected
// CD itself has the desired exposure; checking only source-to-target misses it.
const glb = fs.readFileSync(new URL(`../public/${MUSIC_CD_ASSET.split('?')[0]}`, import.meta.url));
const asset = await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '');
asset.scene.traverse(object => { if (object instanceof THREE.Mesh) normalizeMusicGeometry(object.geometry); });
const shellBounds = new THREE.Box3().setFromObject(asset.scene);
const shaderBounds = a.shader.uniforms.musicShellBounds.value;
assert.ok(Math.abs(shaderBounds.x-shellBounds.min.x)<1e-6,'Warm spine begins at the actual transformed left glass edge');
assert.ok(Math.abs(shaderBounds.y-shellBounds.min.y)<1e-6,'Height falloff begins at the inset bottom edge');
assert.ok(Math.abs(shaderBounds.z-shellBounds.max.y)<1e-6,'Top ribbon peaks at the actual transformed top edge');
assert.ok(Math.abs(1/shaderBounds.w-shellBounds.getSize(new THREE.Vector3()).y)<1e-6,'Light height follows the shortened glass panel');
const falloff = a.shader.uniforms.musicEdgeFalloff.value;
assert.ok(Math.log(2)/falloff.y<0.035,'Top ribbon half-brightness width stays below 0.035 model units');
assert.ok(Math.exp(-MUSIC_MODEL.width*falloff.x)<0.001,'Warm spine transport decays before crossing the entire panel');
assert.ok(a.shader.fragmentShader.includes('vMusicLocal.x - musicShellBounds.x') && a.shader.fragmentShader.includes('musicShellBounds.z - vMusicLocal.y'),'The material shader consumes the geometry bounds for both highlighted edges');
const localAim = a.light.spot.target.position.clone().sub(a.model.position);
assert.ok(localAim.x>shellBounds.min.x && localAim.x<shellBounds.min.x+0.3,'Spot target tracks the thin left glass frame');
assert.ok(localAim.y>shellBounds.min.y && localAim.y<shellBounds.max.y,'Spot target remains inside the actual case height');
// Prints receive diffuse light through their own path, never the shell glow.
const print = createAlbumPrintMaterial(new THREE.Texture());
const printShader = { uniforms: {...THREE.ShaderLib.lambert.uniforms}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
const beforePrint = { uniforms: {...printShader.uniforms}, vertexShader: printShader.vertexShader, fragmentShader: printShader.fragmentShader };
a.light.shade(printShader,'Album_Print');
assert.deepEqual(printShader,beforePrint,'Album artwork receives no glow, tint, transmission or shell-light shader injection');
assert.equal(print.isMeshLambertMaterial,true,'Printed artwork receives diffuse illumination');
assert.equal(print.emissive.getHex(),0,'Printed artwork has no emissive floor');
assert.equal(print.toneMapped,false,'Artwork adds no separate exposure response');
assert.equal(print.fog,true,'Distant prints recede with the archive atmosphere');
a.light.shadePrint(printShader);
assert.equal(printShader.uniforms.musicPrintLightColumn,a.shader.uniforms.musicLightColumn,'Covers follow the same continuous light position as the shell');
assert.ok(printShader.vertexShader.includes('instanceMatrix * musicPrintOrigin'),'Instanced and extracted covers evaluate light in the same world coordinates');
assert.ok(printShader.fragmentShader.includes('outgoingLight *= mix(musicPrintAmbient, 1.0, printLight)'),'The print field only attenuates real diffuse illumination');
const poolBounds = new THREE.Box3();
const focus = {lane:2,row:12};
for(let index=0;index<LOOP_COLUMNS*LOOP_ROWS;index++) {
  const cell = visibleCell(index,focus);
  poolBounds.union(shellBounds.clone().translate(new THREE.Vector3(
    (cell.lane-focus.lane)*COLUMN_SPACING, 0, (cell.row-focus.row)*ROW_SPACING,
  )));
}
// Conservatively include the scan wave, preview/detail lift and returning CDs.
poolBounds.min.y -= 8;
poolBounds.max.y += 8;
let minimumClearance = Infinity;
for(const position of [[-89,3,1],[-62,70,8],[-62,36,43],[-20,17,67]]) {
  a.camera.position.set(...position);a.camera.lookAt(0,0,0);
  a.light.update(a.model,a.camera,0,true,true);
  const delta=a.light.spot.position.clone().sub(a.light.spot.target.position).applyQuaternion(a.camera.quaternion.clone().invert());
  assert.ok(delta.x<0 && delta.y<0,'Key remains screen lower-left through opening, shelf and detail');
  const sourceInPool = a.light.spot.position.clone().sub(a.model.position);
  const clearance = poolBounds.distanceToPoint(sourceInPool);
  minimumClearance = Math.min(minimumClearance,clearance);
  assert.ok(clearance>15,'Source stays well outside the full animated instance pool, preventing near-field corner burns');
  const direction = a.light.spot.target.position.clone().sub(a.light.spot.position).normalize();
  for(const side of [-1,1]) {
    const neighbor = a.light.spot.target.position.clone().add(new THREE.Vector3(side*COLUMN_SPACING,0,0));
    const incidence = neighbor.sub(a.light.spot.position).normalize().dot(direction);
    assert.ok(incidence>Math.cos(a.light.spot.angle),'Both adjacent genre columns lie inside the side-light cone');
  }
}
assert.equal(a.light.spot.distance,0,'Far source must not extinguish the shelf at a finite cutoff');

// The authored opening already eases its large track movement. The light must
// travel with that track on every frame, including a replay after live browsing.
const opening = setup();
opening.model.position.set(5.2,-4.6,-23);
opening.light.update(opening.model,opening.camera,1/60,true,false,true);
assert.ok(opening.column.distanceTo(opening.model.position)<1e-10,'Opening immediately anchors its light field to the entering array');
for(const displacement of [[0,.1,3],[0,.5,7],[0,-.2,8],[0,0,5]]) {
  const movement = new THREE.Vector3(...displacement);
  const oldTarget = opening.light.spot.target.position.clone();
  opening.model.position.add(movement);
  opening.light.update(opening.model,opening.camera,1/60,true,false,true);
  assert.ok(opening.column.distanceTo(opening.model.position)<1e-10,'Opening light field has no additional track lag');
  assert.ok(opening.light.spot.target.position.clone().sub(oldTarget).distanceTo(movement)<1e-10,'Side-light target shares the authored opening translation');
}
opening.model.position.x += COLUMN_SPACING;
opening.light.update(opening.model,opening.camera,.1,true,false);
assert.ok(opening.column.distanceTo(opening.model.position)>1,'Live browsing resumes its smooth handoff after opening');
opening.model.position.set(-5.2,-4.6,-23);
opening.light.update(opening.model,opening.camera,1/60,true,false,true);
assert.ok(opening.column.distanceTo(opening.model.position)<1e-10,'Replay discards the previous browsing anchor and velocity');
const replayTarget = opening.light.spot.target.position.clone();
opening.light.update(opening.model,opening.camera,1/60,true,false);
assert.ok(opening.column.distanceTo(opening.model.position)<1e-10,'A completed opening does not release residual light-field velocity');
assert.ok(opening.light.spot.target.position.distanceTo(replayTarget)<1e-10,'A completed opening does not release residual source velocity');
a.light.update(a.model,a.camera,0,false,false);
assert.equal(a.light.spot.visible,false);
assert.equal(a.light.spot.castShadow,false);
console.log(`Music lighting passed: actual 4.45×3.35 shell edge alignment, narrow warm ribbon, unchanged cover shader, gradual start, frame-rate independence, rapid reversal, reduced motion, lower-left direction, neighboring-column cone coverage, full-pool clearance ${minimumClearance.toFixed(2)}, cinematic track/replay anchoring, empty-library disable.`);
