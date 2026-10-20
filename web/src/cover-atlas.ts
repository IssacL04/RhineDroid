import * as THREE from "three";
import type { MusicSelectionLighting } from "./music-lighting";
import type { ArchiveRecord } from "./data";
import { MUSIC_COVER, createAlbumPrintMaterial } from "./music-model.ts";

// Paper insert inside the thin lid, shared by shelf, selection and viewer.
export const COVER_SIZE = MUSIC_COVER;
export type CoverImage = { source: CanvasImageSource; width: number; height: number };
type DecodedCoverImage = CoverImage & { decodedSize: number; pixels: number };
type DecodeJob = { url: string; generation: number; size: number; resolve: (image: DecodedCoverImage | undefined) => void; image?: HTMLImageElement };
export const COVER_PAINT_SIZE = 1024;
// Use the same UV margin at every texture resolution. A fixed two-pixel inset
// made the 256px atlas artwork smaller than its 1024px lifted/returning copy.
export const COVER_INSET = 1 / 64;
const COVER_PAINT_MARGIN = COVER_PAINT_SIZE * COVER_INSET;

export function containCover(
  width: number,
  height: number,
  boxWidth: number,
  boxHeight: number,
) {
  const scale = Math.min(
    boxWidth / Math.max(1, width),
    boxHeight / Math.max(1, height),
  );
  const drawnWidth = width * scale,
    drawnHeight = height * scale;
  return {
    x: (boxWidth - drawnWidth) / 2,
    y: (boxHeight - drawnHeight) / 2,
    width: drawnWidth,
    height: drawnHeight,
  };
}

export function paintCover(
  canvas: HTMLCanvasElement,
  record: Pick<ArchiveRecord, "title"> | undefined,
  image?: CoverImage,
) {
  const context = canvas.getContext("2d")!;
  // Paint in one logical coordinate space, including fallback art and labels.
  // Ownership can move between atlas/selection/snapshot without rescaling art.
  const width = COVER_PAINT_SIZE,
    height = COVER_PAINT_SIZE,
    margin = COVER_PAINT_MARGIN;
  context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  context.clearRect(0, 0, width, height);
  if (image) {
    const box = containCover(image.width, image.height, width - margin * 2, height - margin * 2);
    context.drawImage(
      image.source,
      box.x + margin,
      box.y + margin,
      box.width,
      box.height,
    );
    return;
  }
  // A missing cover is explicit and never substituted with another album's art.
  const size = height - margin * 2,
    left = (width - size) / 2;
  context.fillStyle = "#c9c9c4";
  context.fillRect(left, margin, size, size);
  context.strokeStyle = "#f8f7f1";
  context.lineWidth = Math.max(1, height / 180);
  context.beginPath();
  context.arc(width / 2, height * 0.43, height * 0.2, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.arc(width / 2, height * 0.43, height * 0.04, 0, Math.PI * 2);
  context.stroke();
  context.fillStyle = "#3f4849";
  context.textAlign = "center";
  context.font = `500 ${Math.max(12, height * 0.045)}px sans-serif`;
  context.fillText(
    record?.title ?? "暂无专辑封面",
    width / 2,
    height * 0.8,
    height * 0.83,
  );
  context.font = `${Math.max(9, height * 0.025)}px sans-serif`;
  context.fillText(
    "LOCAL COLLECTION / NO COVER",
    width / 2,
    height * 0.87,
    height * 0.83,
  );
}

/** One fixed-size atlas for the visible pool, regardless of total library size. */
export class CoverAtlas {
  readonly array: THREE.InstancedMesh;
  readonly selected: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>;
  private readonly atlasCanvas = document.createElement("canvas");
  private readonly selectedCanvas = document.createElement("canvas");
  private readonly tileCanvas = document.createElement("canvas");
  private readonly uploadCanvas = document.createElement("canvas");
  private readonly uploadTexture: THREE.Texture;
  private readonly atlas: THREE.CanvasTexture;
  private readonly selectedTexture: THREE.CanvasTexture;
  private readonly pendingImages = new Map<string, Promise<DecodedCoverImage | undefined>>();
  private readonly decodedImages = new Map<string, DecodedCoverImage | undefined>();
  private readonly decodeJobs = new Map<string, DecodeJob>();
  private readonly decodeQueue: DecodeJob[] = [];
  private readonly activeJobs = new Set<DecodeJob>();
  private readonly dirtySlots = new Set<number>();
  private readonly coverReady: THREE.InstancedBufferAttribute;
  private gpuInitialized = false;
  private uploadedBytes = 0;
  private uploadBatches = 0;
  private uploadedTiles = 0;
  private peakDecodes = 0;
  private decodedPixels = 0;
  private readonly maxDecodeConcurrency = 3;
  private readonly maxDecodedPixels = 4 * 1024 * 1024;
  private readonly slotKeys: (string | undefined)[];
  private readonly recordKeys = new WeakMap<ArchiveRecord, string>();
  private selectedRecord?: ArchiveRecord;
  private selectedKey?: string;
  private generation = 0;
  private disposed = false;
  private readonly columns = 16;
  private readonly rows: number;
  private readonly tileWidth: number;
  private readonly tileHeight: number;

  constructor(count: number, maxTextureSize: number, anisotropy: number, lighting?: MusicSelectionLighting) {
    this.rows = Math.ceil(count / this.columns);
    this.tileWidth = Math.min(
      128,
      Math.floor(maxTextureSize / this.columns),
      Math.floor(maxTextureSize / this.rows),
    );
    this.tileHeight = this.tileWidth;
    this.atlasCanvas.width = this.columns * this.tileWidth;
    this.atlasCanvas.height = this.rows * this.tileHeight;
    this.tileCanvas.width = this.tileWidth;
    this.tileCanvas.height = this.tileHeight;
    this.uploadCanvas.width = this.tileWidth;
    this.uploadCanvas.height = this.tileHeight;
    // This CPU-only source is copied directly into a subregion of the atlas.
    // It must never be initialized as a separate GPU texture.
    this.uploadTexture = new THREE.Texture(this.uploadCanvas);
    this.uploadTexture.colorSpace = THREE.SRGBColorSpace;
    this.uploadTexture.generateMipmaps = false;
    this.selectedCanvas.width = COVER_PAINT_SIZE;
    this.selectedCanvas.height = COVER_PAINT_SIZE;
    this.slotKeys = Array(count);
    this.atlas = new THREE.CanvasTexture(this.atlasCanvas);
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    // No whole-atlas mip pyramid: independent transparent tile margins prevent bleed.
    this.atlas.generateMipmaps = false;
    this.atlas.minFilter = THREE.LinearFilter;
    // Atlas derivatives at steep shelf angles must not sample another tile.
    // Detailed selected art keeps anisotropic filtering on its own texture.
    this.atlas.anisotropy = 1;
    this.atlas.userData.maxAnisotropy = 1;
    this.selectedTexture = new THREE.CanvasTexture(this.selectedCanvas);
    this.selectedTexture.colorSpace = THREE.SRGBColorSpace;
    this.selectedTexture.anisotropy = Math.min(8, anisotropy);
    this.selectedTexture.userData.maxAnisotropy = 8;
    const geometry = new THREE.PlaneGeometry(
      COVER_SIZE.width,
      COVER_SIZE.height,
    ).translate(COVER_SIZE.x, COVER_SIZE.y, COVER_SIZE.z);
    const tileOffsets = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      tileOffsets.set(
        [
          (i % this.columns) / this.columns,
          1 - (Math.floor(i / this.columns) + 1) / this.rows,
          1 / this.columns,
          1 / this.rows,
        ],
        i * 4,
      );
    }
    geometry.setAttribute(
      "coverTile",
      new THREE.InstancedBufferAttribute(tileOffsets, 4),
    );
    this.coverReady = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    this.coverReady.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("coverReady", this.coverReady);
    // Instances, selected art and snapshots use one matte diffuse material and
    // one moving light field; no ownership-specific brightness/scale switches.
    const makePrint = (texture: THREE.Texture) => {
      const print = createAlbumPrintMaterial(texture);
      const compile = print.onBeforeCompile;
      print.onBeforeCompile = (shader, renderer) => {
        compile.call(print, shader, renderer);
        lighting?.shadePrint(shader);
      };
      print.customProgramCacheKey = () => `album-diffuse-print-${Boolean(lighting)}-v4`;
      return print;
    };
    const material = makePrint(this.atlas);
    const compileAtlas = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      compileAtlas.call(material, shader, renderer);
      shader.vertexShader = "attribute vec4 coverTile;\nattribute float coverReady;\nvarying float vCoverReady;\nvarying vec4 vCoverTile;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <uv_vertex>",
        "#include <uv_vertex>\nvCoverReady = coverReady;\nvCoverTile = coverTile;\nvMapUv = coverTile.xy + uv * coverTile.zw;",
      );
      shader.uniforms.coverAtlasTexel = { value: new THREE.Vector2(1 / this.atlasCanvas.width, 1 / this.atlasCanvas.height) };
      shader.fragmentShader = "varying float vCoverReady;\nvarying vec4 vCoverTile;\nuniform vec2 coverAtlasTexel;\n" + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>",
        "if (vCoverReady < 0.5) discard;\n" + THREE.ShaderChunk.map_fragment.replace("texture2D( map, vMapUv )", "texture2D( map, clamp(vMapUv, vCoverTile.xy + coverAtlasTexel * 0.5, vCoverTile.xy + vCoverTile.zw - coverAtlasTexel * 0.5) )"));
    };
    material.customProgramCacheKey = () => `album-diffuse-atlas-${Boolean(lighting)}-v4`;
    this.array = new THREE.InstancedMesh(geometry, material, count);
    this.array.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.array.frustumCulled = false;
    this.array.visible = false;
    this.array.name = "Album cover atlas";
    this.array.receiveShadow = true;
    this.selected = new THREE.Mesh(
      new THREE.PlaneGeometry(COVER_SIZE.width, COVER_SIZE.height).translate(
        COVER_SIZE.x,
        COVER_SIZE.y,
        COVER_SIZE.z,
      ),
      makePrint(this.selectedTexture),
    );
    this.selected.userData.albumCover = true;
    this.selected.visible = false;
    this.selected.name = "Selected album cover";
    this.selected.receiveShadow = true;
  }

  private cachedImage(url?: string) {
    if (!url || !this.decodedImages.has(url)) return undefined;
    const image = this.decodedImages.get(url);
    this.decodedImages.delete(url);
    this.decodedImages.set(url, image);
    return image;
  }

  private loadImage(url?: string, priority = false) {
    if (!url) return Promise.resolve(undefined);
    if (this.disposed) return Promise.resolve(undefined);
    const size = priority ? COVER_PAINT_SIZE : this.tileWidth;
    if (this.decodedImages.has(url)) {
      const cached = this.cachedImage(url);
      if (!cached || cached.decodedSize >= Math.min(size, Math.max(cached.width, cached.height))) return Promise.resolve(cached);
    }
    let pending = this.pendingImages.get(url);
    if (pending) {
      const job = this.decodeJobs.get(url);
      if (job && priority) {
        job.size = Math.max(job.size, size);
        const index = this.decodeQueue.indexOf(job);
        if (index > 0) { this.decodeQueue.splice(index, 1); this.decodeQueue.unshift(job); }
      }
      return pending;
    }
    let resolve!: DecodeJob["resolve"];
    pending = new Promise<DecodedCoverImage | undefined>((done) => { resolve = done; });
    const job: DecodeJob = { url, generation: this.generation, size, resolve };
    this.pendingImages.set(url, pending);
    this.decodeJobs.set(url, job);
    if (priority) this.decodeQueue.unshift(job);
    else this.decodeQueue.push(job);
    this.pumpDecodes();
    return pending;
  }

  private pumpDecodes() {
    while (!this.disposed && this.activeJobs.size < this.maxDecodeConcurrency && this.decodeQueue.length) {
      const job = this.decodeQueue.shift()!;
      const image = new Image();
      job.image = image;
      this.activeJobs.add(job);
      this.peakDecodes = Math.max(this.peakDecodes, this.activeJobs.size);
      image.crossOrigin = "anonymous";
      image.src = job.url;
      void image.decode()
        .then(() => {
          if (this.disposed || job.generation !== this.generation) return undefined;
          // Background slots only retain tile-sized thumbnails. Priority can
          // upgrade an in-flight source before its canvas is produced.
          const width = image.naturalWidth,
            height = image.naturalHeight;
          const scale = Math.min(1, job.size / Math.max(width, height));
          const source = document.createElement("canvas");
          source.width = Math.max(1, Math.round(width * scale));
          source.height = Math.max(1, Math.round(height * scale));
          source
            .getContext("2d")!
            .drawImage(image, 0, 0, source.width, source.height);
          return { source, width, height, decodedSize: Math.max(source.width, source.height), pixels: source.width * source.height };
        })
        .catch(() => undefined)
        .then((decoded) => {
          image.src = "";
          this.activeJobs.delete(job);
          if (!this.disposed && job.generation === this.generation) {
            this.decodedPixels -= this.decodedImages.get(job.url)?.pixels ?? 0;
            this.decodedImages.delete(job.url);
            this.decodedImages.set(job.url, decoded);
            this.decodedPixels += decoded?.pixels ?? 0;
            while (this.decodedImages.size > 48 || this.decodedPixels > this.maxDecodedPixels) {
              const first = this.decodedImages.keys().next().value!;
              this.decodedPixels -= this.decodedImages.get(first)?.pixels ?? 0;
              this.decodedImages.delete(first);
            }
          }
          if (this.decodeJobs.get(job.url) === job) {
            this.decodeJobs.delete(job.url);
            this.pendingImages.delete(job.url);
          }
          job.resolve(this.disposed || job.generation !== this.generation ? undefined : decoded);
          this.pumpDecodes();
        });
    }
  }

  private recordKey(record: ArchiveRecord | undefined) {
    // Description/metadata refreshes replace record objects without changing
    // their print. Cache only the visual identity, not the object reference.
    let key = record ? this.recordKeys.get(record) : "";
    if (record && key === undefined) {
      key = JSON.stringify([record.id, record.album?.coverUrl, record.title]);
      this.recordKeys.set(record, key);
    }
    return key!;
  }

  private copyCover(canvas: HTMLCanvasElement, key: string) {
    const selected = this.selectedKey === key && canvas !== this.selectedCanvas;
    const slot = selected ? -1 : this.slotKeys.indexOf(key);
    if (!selected && slot < 0) return false;
    const context = canvas.getContext("2d")!;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    // Copy the whole painted tile, including its UV inset, exactly once.
    if (selected) context.drawImage(this.selectedCanvas, 0, 0, canvas.width, canvas.height);
    else context.drawImage(
      this.atlasCanvas,
      (slot % this.columns) * this.tileWidth,
      Math.floor(slot / this.columns) * this.tileHeight,
      this.tileWidth, this.tileHeight,
      0, 0, canvas.width, canvas.height,
    );
    return true;
  }

  setSlot(slot: number, record: ArchiveRecord | undefined) {
    const key = this.recordKey(record);
    if (this.slotKeys[slot] === key) return;
    const image = this.cachedImage(record?.album?.coverUrl);
    // Reuse the target album's existing print before assigning this slot's
    // identity; otherwise the lookup could copy the slot's previous album.
    if (image) paintCover(this.tileCanvas, record, image);
    else if (!this.copyCover(this.tileCanvas, key)) paintCover(this.tileCanvas, record);
    this.slotKeys[slot] = key;
    // A recycled instance must not briefly display the previous album while
    // its new tile waits for the bounded GPU upload budget.
    this.coverReady.setX(slot, 0);
    this.coverReady.needsUpdate = true;
    const generation = this.generation;
    const draw = (image?: CoverImage) => {
      if (this.disposed || generation !== this.generation || this.slotKeys[slot] !== key) return;
      if (image) paintCover(this.tileCanvas, record, image);
      const x = (slot % this.columns) * this.tileWidth,
        y = Math.floor(slot / this.columns) * this.tileHeight;
      const context = this.atlasCanvas.getContext("2d")!;
      context.clearRect(x, y, this.tileWidth, this.tileHeight);
      context.drawImage(this.tileCanvas, x, y);
      this.dirtySlots.add(slot);
    };
    draw();
    if (!image) void this.loadImage(record?.album?.coverUrl).then((loaded) => {
      if (loaded) draw(loaded);
    });
  }

  async select(record: ArchiveRecord | undefined) {
    this.selectedRecord = record;
    const key = this.recordKey(record);
    if (this.selectedKey === key) return;
    const generation = this.generation;
    const cached = this.cachedImage(record?.album?.coverUrl);
    if (cached) paintCover(this.selectedCanvas, record, cached);
    else if (!this.copyCover(this.selectedCanvas, key)) paintCover(this.selectedCanvas, record);
    this.selectedKey = key;
    this.selectedTexture.needsUpdate = true;
    if (cached && cached.decodedSize >= Math.min(COVER_PAINT_SIZE, Math.max(cached.width, cached.height))) return;
    const image = await this.loadImage(record?.album?.coverUrl, true);
    if (
      !image ||
      this.disposed ||
      generation !== this.generation ||
      this.selectedKey !== key
    )
      return;
    paintCover(this.selectedCanvas, record, image);
    this.selectedTexture.needsUpdate = true;
  }

  snapshot(mesh: THREE.Mesh) {
    const canvas = document.createElement("canvas");
    canvas.width = this.selectedCanvas.width;
    canvas.height = this.selectedCanvas.height;
    canvas.getContext("2d")!.drawImage(this.selectedCanvas, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.selectedTexture.anisotropy;
    mesh.material = this.selected.material.clone();
    mesh.material.onBeforeCompile = this.selected.material.onBeforeCompile;
    mesh.material.customProgramCacheKey = this.selected.material.customProgramCacheKey;
    (mesh.material as THREE.MeshLambertMaterial).map = texture;
    const record = this.selectedRecord;
    mesh.userData.coverDisposed = false;
    void this.loadImage(record?.album?.coverUrl, true).then((image) => {
      if (!image || mesh.userData.coverDisposed || this.disposed) return;
      paintCover(canvas, record, image);
      texture.needsUpdate = true;
    });
  }

  /** Up to 8 × 256² RGBA pixels (2 MiB), instead of re-uploading 108 MiB. */
  flushUploads(renderer: THREE.WebGLRenderer, maxTiles = 8) {
    if (this.disposed || !this.dirtySlots.size) return 0;
    if (!this.gpuInitialized) {
      // Allocate immutable GPU storage without synchronously uploading the
      // full CPU canvas. Subsequent slots arrive through texSubImage2D copies.
      this.atlas.source.dataReady = false;
      try { renderer.initTexture(this.atlas); this.gpuInitialized = true; }
      finally { this.atlas.source.dataReady = true; }
    }
    const context = this.uploadCanvas.getContext("2d")!;
    const destination = new THREE.Vector2();
    let uploaded = 0;
    const limit = Math.max(1, Math.min(64, Math.floor(maxTiles) || 8));
    for (const slot of this.dirtySlots) {
      const x = (slot % this.columns) * this.tileWidth;
      const y = Math.floor(slot / this.columns) * this.tileHeight;
      context.clearRect(0, 0, this.tileWidth, this.tileHeight);
      context.drawImage(this.atlasCanvas, x, y, this.tileWidth, this.tileHeight, 0, 0, this.tileWidth, this.tileHeight);
      // Canvas rows run downwards; WebGL destination origins run upwards.
      destination.set(x, this.atlasCanvas.height - y - this.tileHeight);
      renderer.copyTextureToTexture(this.uploadTexture, this.atlas, null, destination);
      this.dirtySlots.delete(slot);
      this.coverReady.setX(slot, 1);
      this.uploadedBytes += this.tileWidth * this.tileHeight * 4;
      this.uploadedTiles++;
      if (++uploaded >= limit) break;
    }
    if (uploaded) { this.coverReady.needsUpdate = true; this.uploadBatches++; }
    return uploaded;
  }

  /** Bounded wait for the currently visible requests; no whole-library preload. */
  async prepareVisible(timeoutMs = 1200) {
    const pending = [...this.pendingImages.values()];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = !pending.length || await Promise.race([
      Promise.all(pending).then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, Math.min(3000, timeoutMs))); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return { settled, ...this.getStats() };
  }

  getStats() {
    return {
      atlasWidth: this.atlasCanvas.width, atlasHeight: this.atlasCanvas.height,
      atlasBytes: this.atlasCanvas.width * this.atlasCanvas.height * 4,
      tileWidth: this.tileWidth, tileHeight: this.tileHeight,
      activeDecodes: this.activeJobs.size, queuedDecodes: this.decodeQueue.length,
      pendingImages: this.pendingImages.size, peakDecodes: this.peakDecodes,
      cachedImages: this.decodedImages.size, cachedBytes: this.decodedPixels * 4,
      dirtyTiles: this.dirtySlots.size, uploadedTiles: this.uploadedTiles,
      uploadedBytes: this.uploadedBytes, uploadBatches: this.uploadBatches,
      gpuInitialized: this.gpuInitialized,
    };
  }

  private cancelDecodes() {
    for (const job of this.decodeQueue.splice(0)) job.resolve(undefined);
    for (const job of this.activeJobs) { job.resolve(undefined); if (job.image) job.image.src = ""; }
    this.pendingImages.clear();
    this.decodeJobs.clear();
    this.decodedImages.clear();
    this.decodedPixels = 0;
  }

  reset() {
    this.generation++;
    this.slotKeys.fill(undefined);
    this.selectedRecord = undefined;
    this.selectedKey = undefined;
    this.cancelDecodes();
    this.dirtySlots.clear();
    this.coverReady.array.fill(0);
    this.coverReady.needsUpdate = true;
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.cancelDecodes();
    this.dirtySlots.clear();
    this.uploadTexture.dispose();
    this.atlas.dispose();
    this.selectedTexture.dispose();
    this.array.geometry.dispose();
    (this.array.material as THREE.Material).dispose();
    this.selected.geometry.dispose();
    this.selected.material.dispose();
    this.atlasCanvas.width = this.atlasCanvas.height = 1;
    this.selectedCanvas.width = this.selectedCanvas.height = 1;
    this.tileCanvas.width = this.tileCanvas.height = 1;
    this.uploadCanvas.width = this.uploadCanvas.height = 1;
  }
}
