import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";
import * as THREE from "three";
import { CoverAtlas, COVER_INSET, COVER_PAINT_SIZE, COVER_SIZE, containCover, paintCover } from "../src/cover-atlas.ts";

// Deterministic image decode/canvas harness exercises production ownership and
// drawing code. Pixel quality and GPU transmission are checked in the browser.
class Canvas {
  width = 0; height = 0; token = "empty"; tiles = new Map(); calls = [];
  getContext() {
    return {
      setTransform: (...args) => this.calls.push(["transform", ...args]),
      clearRect: (x, y) => { this.token = "cleared"; this.tiles.delete(`${x},${y}`); },
      fillRect: () => { this.token = "placeholder"; },
      beginPath() {}, arc() {}, stroke() {},
      fillText: (title) => this.calls.push(["text", title]),
      drawImage: (source, ...args) => {
        const token = args.length === 8 ? source.tiles.get(`${args[0]},${args[1]}`) ?? source.token : source.token;
        this.token = token;
        this.calls.push(["draw", token, ...args]);
        if (args.length === 2) this.tiles.set(`${args[0]},${args[1]}`, token);
      },
    };
  }
}
const pending = new Map();
let decodes = 0;
class DeferredImage {
  naturalWidth = 1200; naturalHeight = 800; token = "";
  set src(value) { if (value) this.token = value; else this.reject?.(new DOMException("Cancelled", "AbortError")); }
  decode() {
    decodes++;
    return new Promise((resolve, reject) => { this.reject = reject; pending.set(this.token, { resolve, reject }); });
  }
}
const previousDocument = globalThis.document, previousImage = globalThis.Image;
globalThis.document = { createElement: (name) => { assert.equal(name, "canvas"); return new Canvas(); } };
globalThis.Image = DeferredImage;
const record = (id) => ({ id, title: `Album ${id}`, album: { id, title: `Album ${id}`, coverUrl: `cover-${id}` } });
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

try {
  // Complete art, centred on all aspect ratios, with resolution-independent
  // physical margins. No crop, negative size, UV flip or ownership rescale.
  for (const [width, height] of [[1024, 1024], [1800, 600], [600, 1800], [1, 2000], [2000, 1]]) {
    const box = containCover(width, height, 992, 992);
    assert.ok(Math.abs(box.width / box.height - width / height) < 1e-8);
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 992 && box.y + box.height <= 992);
    const commands = [];
    for (const size of [128, 248, 256, 1024]) {
      const canvas = new Canvas(); canvas.width = canvas.height = size;
      paintCover(canvas, record("art"), { source: { token: "asymmetric-art" }, width, height });
      const draw = canvas.calls.find(call => call[0] === "draw");
      const [, token, x, y, w, h] = draw;
      assert.equal(token, "asymmetric-art");
      assert.ok(x >= COVER_PAINT_SIZE * COVER_INSET && y >= COVER_PAINT_SIZE * COVER_INSET);
      assert.ok(w > 0 && h > 0, "source orientation is preserved");
      assert.ok(x + w <= COVER_PAINT_SIZE * (1 - COVER_INSET));
      assert.ok(y + h <= COVER_PAINT_SIZE * (1 - COVER_INSET));
      commands.push(draw);
    }
    commands.forEach(command => assert.deepEqual(command, commands[0], "atlas, selection and viewer paint in the same UV space"));
  }
  const atlas = new CoverAtlas(32, 4096, 16);
  assert.equal(atlas.array.geometry.attributes.coverTile.count, 32);
  assert.equal(atlas.array.material.map.generateMipmaps, false);
  assert.equal(atlas.array.material.map.anisotropy, 1);
  assert.ok(atlas.selected.material.map.anisotropy > 1);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  atlas.array.material.onBeforeCompile(shader, {});
  assert.ok(shader.fragmentShader.includes("clamp(vMapUv, vCoverTile.xy + coverAtlasTexel * 0.5"), "every sample stays within its own tile centres");
  assert.deepEqual(shader.uniforms.coverAtlasTexel.value.toArray(), [1 / 2048, 1 / 256]);
  const positions = atlas.selected.geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) assert.ok(Math.abs(positions.getZ(i) - COVER_SIZE.z) < 1e-8);
  const uvs = atlas.selected.geometry.attributes.uv;
  assert.deepEqual(Array.from(uvs.array), [0, 1, 1, 1, 0, 0, 1, 0], "front-facing artwork is not reversed");

  const a = record("a"), b = record("b");
  atlas.setSlot(0, a);
  const selectA = atlas.select(a);
  assert.equal(decodes, 1, "slot and selection share one in-flight decode");
  const selectB = atlas.select(b);
  pending.get("cover-b").resolve(); await selectB;
  assert.equal(atlas.selected.material.map.image.token, "cover-b");
  const version = atlas.selected.material.map.version;
  pending.get("cover-a").resolve(); await selectA; await flush();
  assert.equal(atlas.selected.material.map.image.token, "cover-b", "late previous image cannot replace the active cover");
  assert.equal(atlas.selected.material.map.version, version, "late image does not clear or upload the active texture");
  await atlas.select(a);
  assert.equal(atlas.selected.material.map.image.token, "cover-a", "decoded cached artwork is installed synchronously");
  const snapshot = new THREE.Mesh(atlas.selected.geometry, atlas.selected.material);
  atlas.snapshot(snapshot);
  assert.equal(snapshot.material.map.image.token, "cover-a");
  await atlas.select(b);
  assert.equal(snapshot.material.map.image.token, "cover-a", "returning copy owns the old album's pixels");
  atlas.setSlot(1, record("old")); atlas.setSlot(1, record("new"));
  pending.get("cover-new").resolve(); await flush();
  const tile = atlas.array.material.map.image.tiles.get("128,0");
  pending.get("cover-old").resolve(); await flush();
  assert.equal(atlas.array.material.map.image.tiles.get("128,0"), tile, "recycled slots reject stale decoding");
  assert.equal(tile, "cover-new");

  // The standalone viewer calls the same painter, including missing art.
  const url = new URL("../src/viewer-album-cover.ts", import.meta.url);
  const { outputText } = ts.transpileModule(await fs.readFile(url, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  const code = outputText.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) => `from ${JSON.stringify(specifier.startsWith(".") ? new URL(specifier === "./cover-atlas" ? "./cover-atlas.ts" : specifier, url).href : import.meta.resolve(specifier))}`);
  const { ViewerAlbumCover } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const viewer = new ViewerAlbumCover(record("viewer").album, 8);
  pending.get("cover-viewer").resolve(); await viewer.ready;
  assert.equal(viewer.mesh.material.map.image.token, "cover-viewer");
  assert.equal(viewer.mesh.userData.coverStatus, "loaded");
  viewer.dispose();
  const missing = new ViewerAlbumCover({ id: "missing", title: "Missing" });
  await missing.ready;
  assert.equal(missing.mesh.userData.coverStatus, "missing");
  assert.equal(missing.mesh.material.map.image.token, "placeholder");
  missing.dispose();
  const lateViewer = new ViewerAlbumCover(record("late").album);
  lateViewer.dispose(); pending.get("cover-late").resolve(); await lateViewer.ready;
  assert.equal(lateViewer.mesh.userData.coverDisposed, true, "disposing during decode cannot revive a viewer");

  // Cold start: requests are bounded before Image allocation/decode, not merely
  // after completion in the LRU. 432 physical tiles keep one instanced batch.
  const cold = new CoverAtlas(432, 8192, 16);
  const copies = [], allocations = [];
  const renderer = {
    initTexture: texture => allocations.push({ ready: texture.source.dataReady, version: texture.version }),
    copyTextureToTexture: (source, destination, region, position) => copies.push({
      token: source.image.token, position: position.toArray(),
      width: source.image.width, height: source.image.height, region,
    }),
  };
  const versionBefore = cold.array.material.map.version;
  for (let slot = 0; slot < 100; slot++) cold.setSlot(slot, record(`cold-${slot}`));
  assert.deepEqual([cold.getStats().atlasWidth, cold.getStats().atlasHeight, cold.getStats().atlasBytes], [2048, 3456, 27 * 1024 ** 2]);
  assert.equal(cold.getStats().activeDecodes, 3);
  assert.equal(cold.getStats().queuedDecodes, 97);
  assert.equal((await cold.prepareVisible(0)).settled, false, "prewarm has a bounded deadline when sources have not decoded");
  assert.equal(cold.array.geometry.attributes.coverReady.getX(0), 0);
  assert.equal(cold.flushUploads(renderer), 8);
  assert.deepEqual(allocations, [{ ready: false, version: versionBefore }], "initial GPU storage is allocated without uploading the 27 MiB canvas");
  assert.deepEqual(copies[0].position, [0, 3328], "top canvas row maps to the top WebGL tile");
  assert.deepEqual(copies[7].position, [896, 3328]);
  assert.equal(cold.array.geometry.attributes.coverReady.getX(7), 1);
  assert.equal(cold.array.geometry.attributes.coverReady.getX(8), 0, "unuploaded cells cannot show stale artwork");
  assert.equal(cold.getStats().uploadedBytes, 0.5 * 1024 ** 2, "one frame uploads at most 2 MiB at the default budget");
  assert.equal(cold.array.material.map.version, versionBefore, "dirty tile painting never requests a whole-atlas upload");
  const selectedCold = cold.select(record("cold-99"));
  pending.get("cover-cold-0").resolve(); await flush();
  assert.ok(pending.has("cover-cold-99"), "selection jumps ahead of the background decode queue");
  pending.get("cover-cold-99").resolve(); await selectedCold;
  assert.equal(cold.selected.material.map.image.token, "cover-cold-99");
  assert.equal(cold.decodedImages.get("cover-cold-99").decodedSize, 1024, "priority selection keeps detailed artwork");
  assert.equal(cold.decodedImages.get("cover-cold-0").decodedSize, 128, "background cache retains thumbnails rather than 1024px sources");
  const resolved = new Set([0, 99]);
  while (cold.getStats().pendingImages) {
    for (let slot = 0; slot < 100; slot++) if (!resolved.has(slot) && pending.has(`cover-cold-${slot}`)) {
      resolved.add(slot); pending.get(`cover-cold-${slot}`).resolve();
    }
    await flush();
  }
  assert.equal(cold.getStats().peakDecodes, 3);
  assert.ok(cold.getStats().cachedBytes <= 16 * 1024 ** 2);
  assert.ok(cold.getStats().cachedImages <= 48);
  while (cold.getStats().dirtyTiles) cold.flushUploads(renderer);
  assert.equal(allocations.length, 1);
  assert.equal(cold.array.material.map.version, versionBefore);
  const last = copies.find(copy => copy.token === "cover-cold-99");
  assert.deepEqual(last.position, [384, 2560], "each asynchronous result reaches its own flipped atlas row");
  assert.equal(cold.flushUploads(renderer), 0, "settled frames upload nothing");
  assert.equal((await cold.prepareVisible()).settled, true);

  cold.setSlot(0, record("recycle"));
  assert.equal(cold.array.geometry.attributes.coverReady.getX(0), 0, "recycled cells hide old GPU art immediately");
  cold.flushUploads(renderer);
  assert.equal(cold.array.geometry.attributes.coverReady.getX(0), 1);
  const pendingBeforeReset = cold.select(record("reset-stale"));
  cold.reset(); await pendingBeforeReset; await flush();
  assert.equal(cold.getStats().dirtyTiles, 0);
  assert.equal(cold.getStats().pendingImages, 0);
  assert.equal(cold.getStats().activeDecodes, 0);
  assert.equal(cold.getStats().cachedBytes, 0);
  assert.equal(cold.array.geometry.attributes.coverReady.getX(0), 0);
  cold.setSlot(431, record("after-reset"));
  pending.get("cover-after-reset").resolve(); await flush();
  cold.flushUploads(renderer);
  assert.deepEqual(copies.at(-1).position, [1920, 0], "bottom-right tile retains its mapping after reset");
  assert.equal(copies.at(-1).token, "cover-after-reset");
  const pendingAtDisposal = cold.select(record("dispose-active"));
  for (let slot = 0; slot < 8; slot++) cold.setSlot(slot, record(`dispose-queued-${slot}`));
  cold.dispose(); await pendingAtDisposal; await flush();
  assert.equal(cold.getStats().pendingImages, 0);
  assert.equal(cold.getStats().queuedDecodes, 0);
  assert.equal(cold.getStats().activeDecodes, 0);
  assert.equal(cold.flushUploads(renderer), 0, "disposing cancels queue, source decoding and GPU uploads");
  atlas.dispose();
  snapshot.material.map.dispose(); snapshot.material.dispose();
  console.log("V0.4.0 cover pipeline passed: all aspect ratios, shared UV/painter, half-texel guards, 3-source cold-start bound, priority selection, 16 MiB cache cap, 128px atlas tiles, 8-tile/0.5 MiB partial uploads, no stale recycled art, correct top/bottom UV mapping, bounded prewarm, reset/dispose races, independent snapshots and viewer.");
} finally {
  globalThis.document = previousDocument; globalThis.Image = previousImage;
}
