import * as THREE from "three";
import { COVER_SIZE, COVER_PAINT_SIZE, paintCover } from "./cover-atlas";
import type { MusicAlbum } from "./music-types";
import { createAlbumPrintMaterial } from "./music-model.ts";

/** A viewer owns its own print and texture, independent of the array's selection. */
export class ViewerAlbumCover {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>;
  readonly ready: Promise<void>;
  private readonly canvas = document.createElement("canvas");
  private readonly texture: THREE.CanvasTexture;
  private image?: HTMLImageElement;
  private disposed = false;

  constructor(
    readonly album: MusicAlbum,
    anisotropy = 1,
  ) {
    this.canvas.width = COVER_PAINT_SIZE;
    this.canvas.height = COVER_PAINT_SIZE;
    paintCover(this.canvas, album);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = Math.min(8, anisotropy);
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(COVER_SIZE.width, COVER_SIZE.height).translate(
        COVER_SIZE.x,
        COVER_SIZE.y,
        COVER_SIZE.z,
      ),
      createAlbumPrintMaterial(this.texture),
    );
    this.mesh.name = "Album cover print";
    this.mesh.receiveShadow = true;
    this.mesh.userData.albumCover = true;
    this.mesh.userData.albumId = album.id;
    this.mesh.userData.assemblyPart = "cover";
    this.mesh.userData.coverDisposed = false;
    this.mesh.userData.coverStatus = album.coverUrl ? "loading" : "missing";
    this.ready = this.load();
  }

  private async load() {
    if (!this.album.coverUrl) return;
    const image = new Image();
    this.image = image;
    image.crossOrigin = "anonymous";
    image.src = this.album.coverUrl;
    try {
      await image.decode();
      if (this.disposed || this.mesh.userData.coverDisposed) return;
      paintCover(this.canvas, this.album, {
        source: image, width: image.naturalWidth, height: image.naturalHeight,
      });
      this.mesh.userData.coverStatus = "loaded";
      this.mesh.userData.coverImageSize = [
        image.naturalWidth,
        image.naturalHeight,
      ];
      this.texture.needsUpdate = true;
    } catch {
      if (!this.disposed) this.mesh.userData.coverStatus = "missing";
      // Keep this album's explicit missing-cover print; never reuse another album.
    } finally {
      image.src = "";
      if (this.image === image) this.image = undefined;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.userData.coverDisposed = true;
    if (this.image) this.image.src = "";
    this.mesh.removeFromParent();
    this.texture.dispose();
    this.mesh.material.dispose();
    this.mesh.geometry.dispose();
    this.canvas.width = this.canvas.height = 1;
  }
}
