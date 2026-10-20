import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createArchiveLighting, type LightingLook } from "./archive-lighting";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { normalizeQuality, type RenderQuality } from "./render-quality";
import { applyTextureQuality, resizeQuality } from "./quality-renderer";
import { CardAppearance } from "./appearance";
import { configureInternalOptics } from "./internal-optics";
import { DecryptionController } from "./decryption";
import { archiveColumns, columnFiles, fileAtSlot, fileLocation, musicLibrary, records, slotStride } from "./data";
import { CoverAtlas } from "./cover-atlas";
import { MusicSelectionLighting } from "./music-lighting";
import { MusicCameraMotion, MusicPlacementMotion, MusicPresentation, musicArchiveOffset, musicArchiveTracksSettled, musicCinematicPose, musicExtractionAnchor } from "./music-camera";
import { MusicArchiveMotion } from "./music-archive-motion";
import { MusicRealColumns } from "./music-real-columns";
import { musicOverviewColumnExtent, MUSIC_OVERVIEW_PICK_EXTENT } from "./music-overview-edge";
import { MUSIC_CD_ASSET } from "./music-cd-asset";
import { MUSIC_MODEL, configureMusicGlass, musicAssemblyPart, normalizeMusicGeometry } from "./music-model";
import {
  cellKey,
  sameCell,
  selectionCell,
  fileAtCell,
  poolCell,
  visibleCell,
  LOOP_COLUMNS,
  LOOP_ROWS,
  MUSIC_LOOP_ROWS,
  COLUMN_SPACING,
  ROW_SPACING,
  type ArchiveCell,
  type ArchiveNavigation,
} from "./archive-loop";
import { labelMarkSvg } from "./brand";
import { archiveFraming, swipeDirection } from "./viewport-layout";
import { assetUrl as publicAsset } from "./asset-url";
import { ThemeTransition } from "./theme-transition";
import { getMusicMotionSpeed } from "./music-motion-settings";
import { MusicOverviewMotion, overviewFraming, type OverviewColumn } from "./music-overview";
import { isRealAlbumCell, type MusicArrayMode } from "./music-array-layout";
import {
  archiveWave,
  extraction,
  baselineSelectionWave,
  musicSelectionWave,
  rippleEnvelope,
  settlingWave,
  damp,
  columnStrength,
  idleWave,
  cinematicField,
  INSPECTION_LIFT,
  returnStep,
} from "./motion";

const ease = (t: number) => {
  t = THREE.MathUtils.clamp(t, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
// Music browsing exposes a little more artwork; original archives and the
// reference animation keep their 0.4 preview height and existing camera path.
export const MUSIC_PREVIEW_LIFT = 0.9;
// Equal-height boxes clear the shelf after one box height plus a small gap.
// Keep the original archive/reference film's inspection height independent.
export const MUSIC_INSPECTION_LIFT = MUSIC_MODEL.height + 0.12;
const MUSIC_DETAIL_ELEVATION = THREE.MathUtils.degToRad(20);
const MUSIC_ALBUM_SWITCH_RATE = 9;
export class ArchiveScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  // The reference uses a long lens 72–140 units from the cassette. A 0.1 near
  // plane quantizes adjacent optical layers to the same depth (visible shimmer).
  // All visible foreground geometry is beyond 5; retain the framing and lens.
  readonly camera = new THREE.PerspectiveCamera(34, 16 / 9, 5, 300);
  private composer: EffectComposer;
  private ao: SSAOPass;
  private bokeh: BokehPass;
  private instances: THREE.InstancedMesh[] = [];
  private model = new THREE.Group();
  private appearance = new CardAppearance();
  private decryption = new DecryptionController();
  private cursor = new THREE.Vector2();
  private raycaster = new THREE.Raycaster();
  private dummy = new THREE.Object3D();
  private columnExtentOffset = new THREE.Vector3();
  private positions: THREE.Vector3[] = [];
  private poolRows = LOOP_ROWS;
  private cells: ArchiveCell[] = [];
  private selectedCell: ArchiveCell = { lane: 2, row: 12 };
  private looping = false;
  private coordinateOrigin: ArchiveCell = { lane: 0, row: 0 };
  private lift = { value: 0, velocity: 0 };
  private rail = { value: 0, velocity: 0 };
  private shoulder = { value: 12, velocity: 0 };
  private laneFocus = { value: 2, velocity: 0 };
  private columnCamera = { value: 0, velocity: 0 };
  private returnY: number | null = null;
  private canInspect = false;
  private clearance = 0;
  private pulseGain = 1;
  private idleGain = 0;
  private lastInteraction = 0;
  private scanTime = 29.1;
  private scanBlend = 0;
  private cameraAim = new THREE.Vector3();
  private musicCamera = new MusicCameraMotion();
  private musicOverview = new MusicOverviewMotion();
  private musicArrayMode: MusicArrayMode = "filled";
  private musicColumnCounts: number[] = [];
  private musicPresentation = new MusicPresentation();
  private musicPlacement = new MusicPlacementMotion();
  private musicArchiveMotion = new MusicArchiveMotion();
  private musicRealColumns = new MusicRealColumns();
  // A detail-to-detail selection owns its lift independently of placement.
  // Keep that ownership through an interrupted return to avoid a height jump.
  private musicNavigationLift = false;
  private outgoing: {
    group: THREE.Group;
    slot: number;
    cell: ArchiveCell;
    lift: { value: number; velocity: number };
    returnY: number | null;
    clarity: number;
  }[] = [];
  private pulses: { row: number; lane: number; time: number }[] = [];
  private pendingPulse: ArchiveCell | null = null;
  private selectedSlot = 76;
  private detail = 0;
  private targetDetail = 0;
  private reveal = 0;
  private targetReveal = 0;
  private last = 0;
  private pointer = new THREE.Vector2();
  private dragging = false;
  private rotation = 0;
  private targetRotation = 0;
  private light: THREE.DirectionalLight;
  private floor: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private stars?: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private covers?: CoverAtlas;
  private selectionLighting?: MusicSelectionLighting;
  private theme: "day" | "night" | "dusk" = "day";
  private themeWarmth = { value: 1 };
  private themeTransition?: ThemeTransition;
  private clock = 0;
  private loaded = false;
  private labelCanvas = document.createElement("canvas");
  private labelTexture?: THREE.CanvasTexture;
  private labelMark = new Image();
  private reduced = false;
  private quality = normalizeQuality(undefined);
  private appliedQuality = "";
  private disposed = false;
  private smaa = new SMAAPass();
  private aoKernelSize = 32;
  private displayHeight = 0;
  private layoutKind = "";
  onSelect?: (index: number, cell?: ArchiveCell) => void;
  onHover?: (index: number | null) => void;
  onNavigate?: (axis: "row" | "lane", direction: number) => void;
  constructor(
    private container: HTMLElement,
    private readonly selectionPulse = baselineSelectionWave,
    private readonly deferSelectionPulse = false,
    private readonly lightingLook: LightingLook = "baseline",
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(
      Math.min(devicePixelRatio, 1.5) *
        Math.min(innerWidth / 1920, innerHeight / 1080),
    );
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.setAttribute(
      "aria-label",
      "三维研究档案阵列，可点击选择档案",
    );
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color("#eae5e1");
    this.scene.fog = new THREE.Fog("#eae5e1", 22, 47);
    this.light = createArchiveLighting(this.renderer, this.scene, lightingLook);
    this.light.castShadow = true;
    Object.assign(this.light.shadow.camera, {
      left: -16,
      right: 16,
      top: 15,
      bottom: -15,
      near: 0.1,
      far: 45,
    });
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.normalBias = lightingLook === "refined" ? 0.018 : 0.035;
    this.light.shadow.bias = lightingLook === "refined" ? -0.00012 : -0.0003;
    this.light.shadow.radius = 4;
    const floor = this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: "#d8c9b9", roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -4.63;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const starPositions: number[] = [];
    let seed = 417;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 140; i++) starPositions.push(random() * 2 - 1, random() * 2 - 1, 0);
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.Float32BufferAttribute(starPositions, 3));
    this.stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: "#dbeaff", size: 1.5, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false }));
    this.stars.visible = false;
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
    this.camera.position.set(-62.26, 35.98, 43.28);
    this.cameraAim.set(-0.5, 1.1, 0.4);
    this.camera.fov = 6.15;
    this.camera.lookAt(this.cameraAim);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.ao = new SSAOPass(
      this.scene,
      this.camera,
      container.clientWidth,
      container.clientHeight,
    );
    this.ao.kernelRadius = lightingLook === "refined" ? 0.44 : 0.38;
    this.ao.minDistance = 0.001;
    this.ao.maxDistance = 0.09;
    this.composer.addPass(this.ao);
    this.bokeh = new BokehPass(this.scene, this.camera, {
      focus: 25,
      aperture: 0.0018,
      maxblur: 0.011,
    });
    this.composer.addPass(this.bokeh);
    this.smaa.enabled = false;
    this.composer.addPass(this.smaa);
    this.composer.addPass(new OutputPass());
    this.bindPointer();
  }
  async load(assetUrl = publicAsset(musicLibrary ? MUSIC_CD_ASSET : "assets/archive-cassette.glb"), selectedIndex = 0) {
    if (!musicLibrary) {
      this.labelMark.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(labelMarkSvg)}`;
      await this.labelMark.decode();
    }
    const gltf = await new GLTFLoader().loadAsync(
      assetUrl,
    );
    if (this.disposed) return;
    gltf.scene.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    gltf.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    this.poolRows = musicLibrary ? MUSIC_LOOP_ROWS : LOOP_ROWS;
    const count = LOOP_COLUMNS * this.poolRows;
    for (let index = 0; index < count; index++) {
      const cell = poolCell(index, this.poolRows);
      this.cells.push(cell);
      this.positions.push(this.cellPosition(cell));
    }
    for (const mesh of meshes) {
      const geom = mesh.geometry
        .clone()
        .applyMatrix4(mesh.matrixWorld)
        .scale(1, 1, 1);
      if (musicLibrary) normalizeMusicGeometry(geom);
      const source = mesh.material as THREE.MeshStandardMaterial;
      const name = source.name.replace(/\.\d+$/, "");
      const mat = musicLibrary
        ? new THREE.MeshPhysicalMaterial({ name: source.name, side: source.side })
        : source.clone() as THREE.MeshPhysicalMaterial;
      mat.envMapIntensity = 0.6;
      if (name === "Frosted_Polymer") {
        mat.color.set("#fffdfa");
        mat.transmission = 0.9;
        mat.thickness = 0.12;
        mat.roughness = 0.21;
        mat.ior = 1.46;
        mat.attenuationColor = new THREE.Color("#eee6df");
        mat.attenuationDistance = 2;
      }
      if (name === "Internal_Ceramic") {
        mat.color.set(this.lightingLook === "refined" ? "#c4baae" : "#c7beb6");
        mat.roughness = 0.6;
      }
      if (name === "Printed_Label") mat.color.set("#eae5dc");
      if (name === "Ivory_Edges") {
        mat.color.set("#f0e7df");
        mat.roughness = 0.31;
        mat.transmission = 0.65;
        mat.thickness = 0.04;
      }
      if (name === "Optical_Diffuser") {
        mat.color.set("#e2dad4");
        mat.transmission = 0;
        mat.roughness = 0.7;
      }
      if (name === "Subsurface_Optics") {
        mat.color.set(this.lightingLook === "refined" ? "#b9a796" : "#b9aba1");
        mat.roughness = 0.48;
        mat.metalness = 0.05;
      }
      if (name === "Optical_Edges") {
        // Internal refractive shoulders must be in the opaque capture: WebGL's
        // screen-space transmission cannot recursively sample another glass mesh.
        mat.transmission = 0;
        mat.color.set(this.lightingLook === "refined" ? "#d8c7b5" : "#d4c7be");
        mat.roughness = 0.26;
        mat.metalness = 0.08;
      }
      if (musicLibrary) configureMusicGlass(name, mat);
      configureInternalOptics(name, mat);
      if (name === "Carbon_Ink") continue;
      const selectedMesh = new THREE.Mesh(geom, mat);
      selectedMesh.userData.surface = name;
      selectedMesh.userData.musicShell = musicLibrary;
      selectedMesh.castShadow = name === "Optical_Diffuser";
      selectedMesh.receiveShadow = true;
      this.model.add(selectedMesh);
      // Only the shell, edge and fasteners remain visible within tightly packed rows.
      // Keep sub-millimetre optical/typographic geometry on the extracted cassette.
      if (
        ![
          "Frosted_Polymer",
          "Ivory_Edges",
          "Titanium_Fasteners",
          "Index_Inlay",
          "Optical_Diffuser",
        ].includes(name)
      ) {
        this.appearance.register(name, mat);
        continue;
      }
      const arrayMat = mat.clone();
      if (name === "Frosted_Polymer") {
        arrayMat.transmission = 0.78;
        if (this.lightingLook === "refined") {
          // Longer oblique paths pick up the warm body tint, while the thin
          // edges and the extracted clear cover retain a brighter response.
          arrayMat.thickness = 0.28;
          arrayMat.attenuationColor.set("#d4c7b4");
          arrayMat.attenuationDistance = 1.2;
        }
        arrayMat.transparent = false;
        arrayMat.color.set("#fff7ed");
        arrayMat.onBeforeCompile = (shader) => {
          shader.uniforms.archiveWarmth = this.themeWarmth;
          shader.vertexShader =
            "varying float vPanelHeight;\n" + shader.vertexShader;
          shader.vertexShader = shader.vertexShader.replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>\nvPanelHeight = position.y / 3.7;",
          );
          shader.fragmentShader =
            "varying float vPanelHeight;\nuniform float archiveWarmth;\n" + shader.fragmentShader;
          if (!musicLibrary) shader.fragmentShader = shader.fragmentShader.replace(
            "#include <color_fragment>",
            "#include <color_fragment>\ndiffuseColor.rgb *= mix(mix(vec3(0.68, 0.76, 0.86), vec3(1.0), smoothstep(0.1, 1.0, vPanelHeight)), mix(vec3(0.40, 0.30, 0.20), vec3(1.0, 0.98, 0.94), smoothstep(0.1, 1.0, vPanelHeight)), archiveWarmth);",
          );
        };
        arrayMat.roughness = 0.28;
        arrayMat.clearcoat = 0.3;
        arrayMat.clearcoatRoughness = 0.25;
      }
      if (name === "Optical_Diffuser") arrayMat.color.set(musicLibrary ? "#cbb69c" : "#806447");
      if (name === "Ivory_Edges") {
        arrayMat.transmission = 0;
        arrayMat.color.set(
          this.lightingLook === "refined" ? "#dcc9b0" : "#fff5e9",
        );
        arrayMat.roughness = 0.38;
      }
      if (name === "Index_Inlay") {
        arrayMat.color.set("#e4d6c5");
        arrayMat.metalness = 0.05;
      }
      if (musicLibrary) {
        configureMusicGlass(name, arrayMat);
        const baseCompile = arrayMat.onBeforeCompile;
        arrayMat.onBeforeCompile = (shader, renderer) => {
          baseCompile.call(arrayMat, shader, renderer);
          this.selectionLighting?.shade(shader, name);
        };
        arrayMat.customProgramCacheKey = () => `music-guided-glass-${name}`;
      }
      this.appearance.register(name, mat, arrayMat);
      const inst = new THREE.InstancedMesh(geom, arrayMat, count);
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      inst.castShadow = name === "Optical_Diffuser";
      inst.receiveShadow = true;
      inst.frustumCulled = false;
      this.instances.push(inst);
      this.scene.add(inst);
    }
    this.covers = new CoverAtlas(count, this.renderer.capabilities.maxTextureSize, this.renderer.capabilities.getMaxAnisotropy(), this.selectionLighting);
    this.scene.add(this.covers.array);
    this.model.add(this.covers.selected);
    if (!musicLibrary) {
      this.labelCanvas.width = 1024;
      this.labelCanvas.height = 440;
      this.labelTexture = new THREE.CanvasTexture(this.labelCanvas);
      this.labelTexture.colorSpace = THREE.SRGBColorSpace;
      this.labelTexture.anisotropy =
        this.renderer.capabilities.getMaxAnisotropy();
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(0.99, 0.46),
        new THREE.MeshBasicMaterial({
          map: this.labelTexture,
          toneMapped: false,
          transparent: true,
          depthWrite: false,
        }),
      );
      label.position.set(-1.36, 3.04, 0.255);
      label.userData.printedLabel = true;
      this.model.add(label);
    }
    this.appearance.prepare(this.model);
    this.appearance.apply(this.model, 0);
    if (!musicLibrary) this.drawLabel(0);
    this.scene.add(this.model);
    // Logical slots retain their own stride; they are not display-pool indices.
    this.model.position.copy(this.cellPosition(this.selectedCell));
    this.loaded = true;
    if (musicLibrary) await this.refreshLibrary(selectedIndex);
    this.setTheme(this.theme);
  }

  /** Call after setMusicAlbums; reuse the allocated display pool and cover atlas. */
  async refreshLibrary(selectedIndex = 0) {
    if (!this.loaded || !this.covers) return;
    this.musicColumnCounts = archiveColumns.map((_, lane) => columnFiles(lane).length);
    this.musicPresentation.request("hidden");
    this.musicCamera = new MusicCameraMotion();
    this.musicPlacement = new MusicPlacementMotion();
    this.musicArchiveMotion = new MusicArchiveMotion();
    this.musicNavigationLift = false;
    this.targetDetail = this.detail = 0;
    for (const old of this.outgoing) { this.scene.remove(old.group); this.appearance.dispose(old.group); }
    this.outgoing = [];
    this.covers.reset();
    this.covers.array.visible = musicLibrary && records.length > 0;
    this.covers.selected.visible = musicLibrary && records.length > 0;
    this.model.visible = records.length > 0;
    for (const inst of this.instances) inst.visible = records.length > 0;
    for (const child of this.model.children) {
      // Music uses only the shared thin shell and its independent surface print.
      if (child.userData.surface) child.visible = !musicLibrary || child.userData.surface !== "Printed_Label";
      if (child.userData.printedLabel) child.visible = !musicLibrary;
    }
    const index = Math.max(0, Math.min(records.length - 1, selectedIndex));
    const location = fileLocation(index);
    this.selectedSlot = location.slot;
    this.selectedCell = { lane: location.lane, row: location.row };
    this.musicRealColumns.reset(this.musicColumnCounts, this.selectedCell);
    this.coordinateOrigin = { lane: 0, row: 0 };
    this.selectionLighting?.resetRowMotion();
    this.lift = { value: 0, velocity: 0 };
    this.rotation = this.targetRotation = 0;
    this.returnY = null;
    this.pulses = [];
    this.pendingPulse = null;
    this.shoulder = { value: location.row, velocity: 0 };
    this.laneFocus = { value: location.lane, velocity: 0 };
    this.columnCamera = { value: (location.lane - 2) * COLUMN_SPACING, velocity: 0 };
    await this.covers.select(records[index]);
  }

  enableSelectionLighting() {
    this.selectionLighting ??= new MusicSelectionLighting(this.scene);
    this.appearance.musicLighting = this.selectionLighting;
    this.softenMusicContactShadows();
    this.setTheme(this.theme);
  }

  setLightingExperiment(settings: Parameters<MusicSelectionLighting["setExperiment"]>[0]) {
    this.selectionLighting?.setExperiment(settings);
  }

  private softenMusicContactShadows() {
    this.light.shadow.intensity = 0.32;
    this.ao.kernelRadius = 0.18;
    this.ao.maxDistance = 0.035;
    // SSAO assumes opaque solids. Thin transmitting cases need only a soft
    // contact cue: bound the darkest AO multiplier to 0.78, not solid black.
    this.ao.copyMaterial.fragmentShader = this.ao.copyMaterial.fragmentShader.replace(
      "gl_FragColor = opacity * texel;",
      "gl_FragColor = vec4(mix(vec3(1.0), texel.rgb, 0.22), texel.a);",
    );
    this.ao.copyMaterial.needsUpdate = true;
  }

  setTheme(theme: "day" | "night" | "dusk", animate = false) {
    this.theme = theme;
    // A new request samples the currently rendered colors/intensities. It
    // replaces the previous targets without finishing the previous transition.
    const targets = new ThemeTransition();
    targets.number(this.themeWarmth, "value", theme === "day" ? 1 : 0);
    const background = theme === "night" ? "#07111f" : theme === "dusk" ? "#b9c7cc" : "#eae5e1";
    targets.color(this.scene.background as THREE.Color, background);
    targets.color((this.scene.fog as THREE.Fog).color, background);
    targets.color(this.floor.material.color, theme === "night" ? "#0b1828" : theme === "dusk" ? "#a6b8c0" : "#d8c9b9");
    targets.number(this.renderer, "toneMappingExposure", theme === "night" ? 1.08 : 1.05);
    targets.number(this.scene, "environmentIntensity", theme === "night" ? .68 : .48);
    targets.color(this.light.color, theme === "night" ? "#e5f0ff" : theme === "dusk" ? "#eff8ff" : "#fff7ed");
    targets.number(this.light, "intensity", theme === "night" ? 1.7 : 1.4);
    for (const child of this.scene.children) if (child instanceof THREE.HemisphereLight) {
      targets.color(child.color, theme === "night" ? "#e2eeff" : "#fffaf5");
      targets.color(child.groundColor, theme === "night" ? "#56708c" : theme === "dusk" ? "#718898" : "#b4a18c");
      targets.number(child, "intensity", theme === "night" ? .9 : .65);
    }
    if (this.stars) targets.number(this.stars.material, "opacity", theme === "night" ? .6 : 0);
    this.appearance.setTheme(theme, targets);
    this.selectionLighting?.setTheme(theme, this.light, targets);
    this.themeTransition = animate && !this.reduced && musicLibrary ? targets : undefined;
    if (!this.themeTransition) targets.finish();
    this.syncThemeStars();
  }

  private syncThemeStars() {
    if (this.stars) this.stars.visible = this.stars.material.opacity > 0;
  }

  private assemblyTemplate?: Promise<THREE.Group>;
  private musicAssemblyTemplate?: Promise<THREE.Group>;
  private async createMusicAssemblyModel() {
    this.musicAssemblyTemplate ??= new GLTFLoader()
      .loadAsync(publicAsset(MUSIC_CD_ASSET))
      .then((gltf) => {
        gltf.scene.updateMatrixWorld(true);
        return gltf.scene;
      })
      .catch((error) => {
        this.musicAssemblyTemplate = undefined;
        throw error;
      });
    const template = await this.musicAssemblyTemplate;
    const model = new THREE.Group();
    const meshes: THREE.Mesh[] = [];
    template.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const surface = (object.material as THREE.Material).name.replace(/\.\d+$/, "");
      const geometry = normalizeMusicGeometry(object.geometry.clone().applyMatrix4(object.matrixWorld));
      const mesh = new THREE.Mesh(geometry, object.material);
      mesh.userData.surface = surface;
      mesh.userData.musicShell = true;
      mesh.userData.assemblyPart = musicAssemblyPart(surface);
      model.add(mesh);
      meshes.push(mesh);
    });
    this.appearance.prepare(model);
    this.appearance.apply(model, 1);
    this.appearance.setClarity(model, 1);
    model.userData.musicShell = true;
    return {
      model,
      setClarity: (value: number) => this.appearance.setClarity(model, value),
      dispose: () => {
        for (const mesh of meshes) {
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
      },
    };
  }

  async createAssemblyModel() {
    if (musicLibrary) return this.createMusicAssemblyModel();
    this.assemblyTemplate ??= new GLTFLoader()
      .loadAsync(publicAsset("assets/archive-assembly.glb"))
      .then((gltf) => {
        gltf.scene.updateMatrixWorld(true);
        return gltf.scene;
      })
      .catch((error) => {
        this.assemblyTemplate = undefined;
        throw error;
      });
    const template = await this.assemblyTemplate;
    const model = new THREE.Group();
    const meshes: THREE.Mesh[] = [];
    template.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const name = (object.material as THREE.Material).name.replace(
        /\.\d+$/,
        "",
      );
      const mesh = new THREE.Mesh(
        object.geometry.clone().applyMatrix4(object.matrixWorld),
        object.material,
      );
      mesh.userData.surface = name;
      mesh.userData.assemblyPart = object.userData.assemblyPart;
      model.add(mesh);
      meshes.push(mesh);
    });
    this.appearance.prepare(model);
    this.appearance.apply(model, 1);
    this.appearance.setClarity(model, this.decryption.clarity);
    const canvas = document.createElement("canvas");
    canvas.width = this.labelCanvas.width;
    canvas.height = this.labelCanvas.height;
    canvas.getContext("2d")!.drawImage(this.labelCanvas, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.99, 0.46),
      new THREE.MeshBasicMaterial({
        map: texture,
        toneMapped: false,
        transparent: true,
        depthWrite: false,
      }),
    );
    label.position.set(-1.36, 3.04, 0.255);
    label.userData.assemblyPart = "cover";
    label.userData.printedLabel = true;
    model.add(label);
    meshes.push(label);
    return {
      model,
      setClarity: (value: number) => this.appearance.setClarity(model, value),
      dispose: () => {
        for (const mesh of meshes) {
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
        texture.dispose();
      },
    };
  }
  setMode(mode: "hidden" | "archive" | "detail") {
    if (mode !== "archive") this.musicOverview.active = false;
    if (mode === "hidden") this.musicOverview.reset();
    if (musicLibrary) this.musicPresentation.request(mode);
    if (musicLibrary && mode === "hidden") {
      this.musicCamera = new MusicCameraMotion();
      this.musicPlacement = new MusicPlacementMotion();
      this.musicArchiveMotion = new MusicArchiveMotion();
      this.musicNavigationLift = false;
    }
    if (mode === "detail") this.decryption.enter(this.scanBlend > .9 && this.decryption.clarity > .999);
    else this.decryption.leave();
    if (mode === "hidden") this.decryption.select();
    if (mode !== "archive") this.pendingPulse = null;
    this.looping = mode !== "hidden";
    if (!this.looping) {
      const canonical = fileLocation(fileAtSlot(this.selectedSlot));
      this.selectedCell = { lane: canonical.lane, row: canonical.row };
      this.musicRealColumns.reset(this.musicColumnCounts, this.selectedCell);
      this.coordinateOrigin = { lane: 0, row: 0 };
      for (const old of this.outgoing) {
        this.scene.remove(old.group);
        this.appearance.dispose(old.group);
      }
      this.outgoing = [];
    }
    this.lastInteraction = this.clock;
    this.targetReveal = mode === "hidden" ? 0 : 1;
    this.targetDetail = musicLibrary
      ? Number(this.musicPresentation.holdsDetail)
      : mode === "detail" ? 1 : 0;
    this.dragging = false;
    if (mode !== "detail") {
      this.targetRotation = 0;
      if (this.rotation !== 0) this.returnY = this.model.position.y;
    } else this.returnY = null;
  }
  setReduced(value: boolean) {
    this.reduced = value;
    if (value && this.themeTransition) {
      this.themeTransition.finish();
      this.themeTransition = undefined;
      this.syncThemeStars();
    }
  }
  setMusicOverview(active: boolean) {
    this.musicOverview.active = active;
    this.pointer.set(0, 0);
  }
  setMusicArrayMode(mode: MusicArrayMode) {
    if (mode === this.musicArrayMode) return;
    this.musicArrayMode = mode;
    if (!this.loaded || !records.length) return;
    const location = fileLocation(fileAtSlot(this.selectedSlot));
    const laneShift = location.lane - this.selectedCell.lane;
    const rowShift = location.row - this.selectedCell.row;
    this.selectedCell = { lane: location.lane, row: location.row };
    this.columnCamera.value += laneShift * COLUMN_SPACING;
    this.rail.value -= rowShift * ROW_SPACING;
    this.laneFocus.value += laneShift;
    this.shoulder.value += rowShift;
    this.musicRealColumns.reset(this.musicColumnCounts, this.selectedCell,
      this.musicColumnCounts.map(() => this.musicBrowseRow));
    this.musicArchiveMotion.translate({ column: laneShift * COLUMN_SPACING,
      rail: -rowShift * ROW_SPACING, lane: laneShift, shoulder: rowShift });
    this.coordinateOrigin = { lane: 0, row: 0 };
    for (const old of this.outgoing) { this.scene.remove(old.group); this.appearance.dispose(old.group); }
    this.outgoing = [];
    this.pulses = [];
    this.pendingPulse = null;
    this.selectionLighting?.resetRowMotion();
  }
  private actualCell(cell: ArchiveCell) {
    return !musicLibrary || this.musicArrayMode === "filled" ||
      isRealAlbumCell(cell.lane, cell.row, this.musicColumnCounts);
  }
  private musicColumnExtent(lane: number) {
    return !musicLibrary || !this.looping ? 1 : musicOverviewColumnExtent(lane,
      this.columnCamera.value / COLUMN_SPACING + 2, this.musicOverview.value);
  }
  private pickableCell(cell: ArchiveCell) {
    return this.actualCell(cell) && this.musicColumnExtent(cell.lane) >= MUSIC_OVERVIEW_PICK_EXTENT;
  }
  private applyMusicColumnExtent(object: THREE.Object3D, extent: number) {
    if (extent <= 0) { object.scale.setScalar(0); return; }
    object.scale.set(1, extent, 1);
    if (extent === 1) return;
    // Geometry is authored with its base 0.175 above local zero. Compensate
    // after rotation, keeping that base fixed for shell, insert and copies.
    const bottom = MUSIC_MODEL.center.y - MUSIC_MODEL.height / 2;
    object.position.add(this.columnExtentOffset.set(0, bottom * (1 - extent), 0).applyQuaternion(object.quaternion));
  }
  get musicOverviewProgress() { return this.musicOverview.value; }
  /** Actual displayed depth, including while a previous selection is moving. */
  get musicBrowseRow() { return (-this.rail.value - 2.17) / ROW_SPACING + 15.5; }

  /** The target shelf's own displayed depth; inactive real shelves stay centered. */
  musicBrowseRowForColumn(lane: number) {
    return this.musicArrayMode === "realistic"
      ? this.musicRealColumns.row(lane, this.musicOverview.value) : this.musicBrowseRow;
  }

  /** Address a nearby physical column without inheriting an old selection's loop. */
  musicColumnCell(lane: number, row: number): ArchiveCell {
    const centerLane = this.columnCamera.value / COLUMN_SPACING + 2;
    return { lane: this.musicArrayMode === "filled"
      ? lane + Math.round((centerLane - lane) / archiveColumns.length) * archiveColumns.length
      : lane, row };
  }

  private musicColumnRowOffset(lane: number) {
    if (!musicLibrary || this.musicArrayMode !== "realistic") return 0;
    return this.musicBrowseRow - this.musicRealColumns.row(lane, this.musicOverview.value);
  }

  /** Unselected finite shelves keep their own quiet wave throughout navigation. */
  private musicRealColumnField(row: number, lane: number, time: number) {
    const activity = this.musicRealColumns.activity(lane);
    let height = this.reduced ? 0 : idleWave(row, lane, time) *
      THREE.MathUtils.lerp(1, this.idleGain, activity);
    if (!this.reduced && activity > 0) {
      let ripple = 0;
      for (const pulse of this.pulses) {
        if (pulse.lane !== lane) continue;
        const distance = Math.abs(row - pulse.row), age = time - pulse.time;
        ripple += musicSelectionWave(distance, age) *
          (this.deferSelectionPulse ? rippleEnvelope(distance, age) : 1);
      }
      height += THREE.MathUtils.clamp(ripple, -.24, .24) * this.pulseGain * activity;
    }
    return height + settlingWave(row - this.musicRealColumns.row(lane, this.musicOverview.value), 26.56) * activity;
  }

  private visibleMusicCell(index: number, center: ArchiveCell) {
    const cell = visibleCell(index, center, this.poolRows);
    const rowOffset = this.musicColumnRowOffset(cell.lane);
    if (rowOffset === 0) return cell;
    // Each centered column needs its own window, including albums beyond row 48.
    return visibleCell(index, { lane: center.lane,
      row: center.row - rowOffset }, this.poolRows);
  }

  getOverviewColumns(): OverviewColumn[] {
    if (!this.loaded || !archiveColumns.length) return [];
    const width = this.container.clientWidth, height = this.container.clientHeight;
    const centerLane = this.columnCamera.value / COLUMN_SPACING + 2;
    const selectedLane = ((this.selectedCell.lane % archiveColumns.length) + archiveColumns.length) % archiveColumns.length;
    return archiveColumns.flatMap((name, lane) => {
      const physical = this.musicArrayMode === "realistic" ? lane :
        lane + Math.round((centerLane - lane) / archiveColumns.length) * archiveColumns.length;
      // Keep projecting through the full edge envelope so retiring labels
      // follow their columns until both reach zero at the pool's recycle line.
      if (Math.abs(physical - centerLane) > 4.5) return [];
      const count = columnFiles(lane).length;
      if (!count) return [];
      const browsingRow = (-this.rail.value - 2.17) / ROW_SPACING + 15.5;
      const rowOffset = this.musicColumnRowOffset(lane);
      const anchorRow = this.musicArrayMode === "realistic" ?
        THREE.MathUtils.clamp(browsingRow - rowOffset, 12, 11 + count) : browsingRow;
      const anchorZ = (anchorRow + rowOffset - 15.5) * ROW_SPACING + this.rail.value;
      // Labels follow the same column shift; even counts anchor between the middle pair.
      const extent = this.musicColumnExtent(physical);
      const point = new THREE.Vector3((physical - 2) * COLUMN_SPACING - this.columnCamera.value,
        -4.6 + MUSIC_MODEL.center.y - MUSIC_MODEL.height / 2 + (MUSIC_MODEL.height + .65) * extent,
        anchorZ).project(this.camera);
      if (point.z < -1 || point.z > 1) return [];
      return [{ lane, name, count, extent,
        x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2, selected: lane === selectedLane }];
    });
  }
  /** The intro has already rendered the archive pose; hand over its same state. */
  finishMusicIntro(nowSeconds: number) {
    if (!musicLibrary || !this.loaded) return;
    this.musicNavigationLift = false;
    this.clock = this.last = this.lastInteraction = nowSeconds;
    this.setMode("archive");
    this.reveal = this.targetReveal = 1;
    this.detail = this.targetDetail = 0;
    this.rotation = this.targetRotation = 0;
    this.returnY = null;
    this.dragging = this.canInspect = false;
    this.scanTime = 29.1;
    this.scanBlend = this.idleGain = 0;
    this.pulses = [];
    this.pendingPulse = null;
    this.pointer.set(0, 0);
    // The final preview hold is at rest. Discard finite-difference velocity
    // from the film and seed browsing with the rendered position/FOV intact.
    this.musicCamera = new MusicCameraMotion();
    this.musicCamera.observe(this.camera, this.cameraAim, 0);
    this.musicPresentation.update(0, true, true, true);
  }
  showMusicArchiveImmediately(nowSeconds: number) {
    if (!musicLibrary || !this.loaded) return;
    this.musicPresentation = new MusicPresentation();
    this.musicCamera = new MusicCameraMotion();
    this.musicPlacement = new MusicPlacementMotion();
    this.musicArchiveMotion = new MusicArchiveMotion();
    this.musicNavigationLift = false;
    this.clock = this.last = this.lastInteraction = nowSeconds;
    this.setMode("archive");
    this.reveal = this.targetReveal = 1;
    this.detail = this.targetDetail = 0;
    this.rotation = this.targetRotation = 0;
    this.returnY = null;
    this.dragging = this.canInspect = false;
    this.pointer.set(0, 0);
    this.lift = { value: MUSIC_PREVIEW_LIFT, velocity: 0 };
    const chosen = this.cellPosition(this.selectedCell);
    this.rail = { value: -2.17 - chosen.z, velocity: 0 };
    this.columnCamera = { value: chosen.x, velocity: 0 };
    this.shoulder = { value: this.selectedCell.row, velocity: 0 };
    this.laneFocus = { value: this.selectedCell.lane, velocity: 0 };
    this.musicRealColumns.reset(this.musicColumnCounts, this.selectedCell);
    this.scanTime = 29.1;
    this.scanBlend = this.idleGain = 0;
    this.pulseGain = 1;
    this.pulses = [];
    this.pendingPulse = null;
    for (const old of this.outgoing) {
      this.scene.remove(old.group);
      this.appearance.dispose(old.group);
    }
    this.outgoing = [];
    this.decryption.select();
    const reduced = this.reduced;
    try {
      // Snap and render the existing archive targets before the first visible
      // frame; subsequent updates resume the user's normal motion preference.
      this.reduced = true;
      this.update(nowSeconds);
    } finally {
      this.reduced = reduced;
    }
  }
  setQuality(value: RenderQuality | boolean) {
    if (this.disposed) return;
    const quality =
      typeof value === "boolean"
        ? normalizeQuality(undefined, value)
        : normalizeQuality(value);
    const key = JSON.stringify(quality);
    if (this.appliedQuality === key) return;
    this.appliedQuality = key;
    this.quality = quality;
    if (quality.aoSamples && quality.aoSamples !== this.aoKernelSize) {
      const old = this.ao;
      this.ao = new SSAOPass(this.scene, this.camera, 1, 1, quality.aoSamples);
      this.ao.kernelRadius = old.kernelRadius;
      this.ao.minDistance = old.minDistance;
      this.ao.maxDistance = old.maxDistance;
      const index = this.composer.passes.indexOf(old);
      this.composer.removePass(old);
      this.composer.insertPass(this.ao, index);
      old.dispose();
      this.aoKernelSize = quality.aoSamples;
      if (this.selectionLighting) this.softenMusicContactShadows();
    }
    this.ao.enabled = quality.aoSamples > 0;
    this.bokeh.enabled = quality.depthOfField > 0;
    this.smaa.enabled = quality.antialias === "smaa";
    this.renderer.shadowMap.enabled = quality.shadows > 0;
    const size = Math.min(
      quality.shadows || 1024,
      this.renderer.capabilities.maxTextureSize,
    );
    if (this.light.shadow.mapSize.x !== size) {
      this.light.shadow.map?.dispose();
      this.light.shadow.map = null;
      this.light.shadow.mapSize.set(size, size);
    }
    this.light.shadow.needsUpdate = true;
    applyTextureQuality(this.scene, this.renderer, quality);
    this.resize();
  }
  private cellPosition(cell: ArchiveCell) {
    return new THREE.Vector3(
      (cell.lane - 2) * COLUMN_SPACING,
      -4.6,
      (cell.row - 15.5) * ROW_SPACING,
    );
  }
  private rebaseCoordinates() {
    if (musicLibrary && this.musicArrayMode === "realistic") return;
    // Periodically reduce the logical coordinates while preserving every
    // relative position, spring velocity, ripple and idle phase.
    const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
    const rowPeriod = archiveColumns.reduce((period, _, lane) => {
      const count = columnFiles(lane).length || 1;
      const next = period / gcd(period, count) * count;
      return next > 1e6 ? Infinity : next;
    }, 1);
    const lanePeriod = Math.max(1, archiveColumns.length);
    const shift = {
      lane:
        Math.abs(this.selectedCell.lane) > 2048
          ? Math.round((this.selectedCell.lane - 2) / lanePeriod) * lanePeriod
          : 0,
      row:
        Math.abs(this.selectedCell.row) > Math.max(2048, rowPeriod * 2)
          ? Math.floor((this.selectedCell.row - 12) / rowPeriod) * rowPeriod
          : 0,
    };
    if (!shift.lane && !shift.row) return;
    this.selectedCell.lane -= shift.lane;
    this.selectedCell.row -= shift.row;
    this.coordinateOrigin.lane += shift.lane;
    this.coordinateOrigin.row += shift.row;
    this.laneFocus.value -= shift.lane;
    this.shoulder.value -= shift.row;
    this.columnCamera.value -= shift.lane * COLUMN_SPACING;
    this.rail.value += shift.row * ROW_SPACING;
    this.musicArchiveMotion.translate({ column: -shift.lane * COLUMN_SPACING,
      rail: shift.row * ROW_SPACING, lane: -shift.lane, shoulder: -shift.row });
    for (const old of this.outgoing) {
      old.cell.lane -= shift.lane;
      old.cell.row -= shift.row;
    }
    for (const pulse of this.pulses) {
      pulse.lane -= shift.lane;
      pulse.row -= shift.row;
    }
    if (this.pendingPulse) {
      this.pendingPulse.lane -= shift.lane;
      this.pendingPulse.row -= shift.row;
    }
  }
  /** Retarget the detail rail without replaying the archive/inspection move. */
  switchMusicAlbum(index: number, navigation?: ArchiveNavigation) {
    if (!musicLibrary || !this.loaded || !records[index] || !this.musicPresentation.placed) return;
    this.musicNavigationLift = true;
    this.dragging = this.canInspect = false;
    this.select(index, navigation);
    this.decryption.enter(this.decryption.clarity > .999);
    this.pendingPulse = null;
  }
  select(index: number, navigation?: ArchiveNavigation) {
    if (!records[index]) return;
    // Browsing can resume before the return camera is fully settled. A new
    // browsing selection must not inherit the previous detail box's lift mode.
    if (musicLibrary && !this.musicPresentation.placed) this.musicNavigationLift = false;
    this.lastInteraction = this.clock;
    const next = fileLocation(index).slot;
    const canonical = fileLocation(index);
    const cell = this.looping && (!musicLibrary || this.musicArrayMode === "filled")
      ? selectionCell(index, this.selectedCell, navigation)
      : { lane: canonical.lane, row: canonical.row };
    // Restoring a column's remembered album can span many rows even though the
    // input was one horizontal step. Give that travel the search cadence too.
    const distantColumnSelection = cell.lane !== this.selectedCell.lane &&
      Math.abs(cell.row - this.selectedCell.row) > 1;
    const changed = !sameCell(cell, this.selectedCell);
    if (musicLibrary && changed) this.musicPresentation.selectionChanged();
    if (this.looping && changed && this.loaded && this.lift.value > 0.0001) {
      const group = this.model.clone(true);
      this.appearance.prepare(group);
      const cover = group.children.find((child) => child.userData.albumCover) as THREE.Mesh | undefined;
      if (cover) this.covers?.snapshot(cover);
      const label = group.children.find((child) => child.userData.printedLabel) as THREE.Mesh | undefined;
      if (label) {
        const canvas = document.createElement("canvas");
        canvas.width = 1024;
        canvas.height = 440;
        canvas.getContext("2d")!.drawImage(this.labelCanvas, 0, 0);
        const map = new THREE.CanvasTexture(canvas);
        map.colorSpace = THREE.SRGBColorSpace;
        label.material = new THREE.MeshBasicMaterial({
          map,
          toneMapped: false,
          transparent: true,
          depthWrite: false,
        });
      }
      this.appearance.apply(group, ease(this.lift.value / 0.4));
      this.appearance.setClarity(group, this.decryption.clarity);
      this.scene.add(group);
      this.outgoing.push({
        group,
        slot: this.selectedSlot,
        cell: { ...this.selectedCell },
        lift: { ...this.lift },
        returnY: group.rotation.y !== 0 ? group.position.y : null,
        clarity: this.decryption.clarity,
      });
      this.lift.value = 0;
      this.lift.velocity = 0;
    }
    this.selectedSlot = next;
    this.selectedCell = cell;
    if (musicLibrary && changed && this.musicArrayMode === "realistic") {
      this.musicRealColumns.select(cell, {
        guided: !navigation || ("cell" in navigation && navigation.guided === true),
        detail: this.musicPresentation.placed,
      });
    }
    if (musicLibrary && changed && this.loaded && !this.musicPresentation.placed &&
      (!navigation || ("cell" in navigation && navigation.guided) || distantColumnSelection || this.musicArchiveMotion.active)) {
      // Search, overview entry and distant column restoration share one cadence.
      // Directional input during a search continues from its current derivatives.
      const chosen = this.cellPosition(cell);
      this.musicArchiveMotion.retarget(
        { rail: this.rail, column: this.columnCamera, shoulder: this.shoulder, lane: this.laneFocus },
        { rail: -2.17 - chosen.z, column: chosen.x, shoulder: cell.row, lane: cell.lane });
    }
    if (changed) {
      this.decryption.select();
      this.rotation = 0;
      this.returnY = null;
    }
    const returning = this.outgoing.findIndex((o) => sameCell(o.cell, cell));
    if (returning >= 0) {
      const o = this.outgoing[returning];
      this.lift = { ...o.lift };
      this.rotation = o.group.rotation.y;
      this.returnY = o.returnY;
      this.decryption.select(o.clarity);
      this.scene.remove(o.group);
      this.appearance.dispose(o.group);
      this.outgoing.splice(returning, 1);
    }
    if (musicLibrary && this.musicNavigationLift && this.musicPresentation.placed) {
      // Detail navigation moves the shelf itself; a browsing ripple would
      // reintroduce vertical motion underneath the fixed inspection camera.
      this.pendingPulse = null;
    } else if (this.deferSelectionPulse) {
      this.pendingPulse = this.looping ? { ...cell } : null;
    } else this.emitPulse(cell);
    this.targetRotation = 0;
    if (!musicLibrary) this.drawLabel(index);
    if (musicLibrary) void this.covers?.select(records[index]);
  }
  private emitPulse(cell: ArchiveCell) {
    this.pulses.push({ ...cell, time: this.clock });
    this.pulses = this.pulses.slice(-6);
  }
  private drawLabel(index: number) {
    if (!this.labelTexture) return;
    const c = this.labelCanvas.getContext("2d")!;
    c.fillStyle = "#e6e2d9";
    c.fillRect(0, 0, 1024, 440);
    c.fillStyle = "#171713";
    c.fillRect(12, 12, 1000, 6);
    c.fillRect(12, 419, 1000, 3);
    c.font = "bold 81px MiSans";
    c.fillText("RHINE LAB, LLC.", 22, 116);
    c.font = "32px MiSans";
    c.fillStyle = "#878476";
    c.fillText("INTERNAL DATABASE", 25, 174);
    c.fillStyle = "#171713";
    c.font = "bold 130px MiSans";
    c.fillText("NO." + String(index + 1).padStart(3, "0"), 22, 360);
    c.fillRect(782, 32, 221, 39);
    c.fillStyle = "#eee9de";
    c.font = "24px MiSans";
    c.fillText("R L / I S", 809, 61);
    c.fillStyle = "#171713";
    c.font = "bold 64px MiSans";
    c.fillText("INFO", 830, 143);
    c.drawImage(this.labelMark, 790, 242, 210, 98);
    this.labelTexture.needsUpdate = true;
  }
  resize() {
    if (this.disposed) return;
    const w = this.container.clientWidth,
      h = this.container.clientHeight;
    const kind = this.container.closest<HTMLElement>("[data-layout]")?.dataset.layout ?? "";
    const displayHeight = this.container.getBoundingClientRect().height;
    if (this.layoutKind === "cinematic" && kind !== "cinematic" && this.displayHeight > 0) {
      // Removing letterboxing starts from the same apparent model size. The
      // existing camera interpolation then carries it to the responsive anchor.
      this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(
        Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * displayHeight / this.displayHeight,
      ));
    }
    this.displayHeight = displayHeight;
    this.layoutKind = kind;
    const dimensions = resizeQuality(
      this.renderer,
      this.composer,
      this.container,
      this.quality,
    );
    this.ao.setSize(
      Math.max(1, Math.floor(dimensions.width * this.quality.aoResolution)),
      Math.max(1, Math.floor(dimensions.height * this.quality.aoResolution)),
    );
    this.container.dataset.renderQuality = JSON.stringify({
      ...JSON.parse(this.container.dataset.renderQuality!),
      aoSamples: this.ao.enabled ? this.aoKernelSize : 0,
      aoWidth: this.ao.width,
      aoHeight: this.ao.height,
      shadows: this.renderer.shadowMap.enabled
        ? this.light.shadow.mapSize.x
        : 0,
      depthOfField: this.bokeh.enabled ? this.quality.depthOfField : 0,
    });
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  private bindPointer() {
    const canvas = this.renderer.domElement;
    let startX = 0,
      startY = 0;
    let activePointer: number | null = null, previousX = 0, started = 0, cancelled = false;
    const pointers = new Set<number>();
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pointers.add(e.pointerId);
      if (pointers.size > 1) { cancelled = true; this.dragging = false; return; }
      activePointer = e.pointerId;
      cancelled = false;
      previousX = e.clientX;
      started = performance.now();
      startX = e.clientX;
      startY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      if (this.canInspect) {
        this.dragging = true;
        canvas.setPointerCapture(e.pointerId);
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (activePointer !== null && e.pointerId !== activePointer) return;
      if (cancelled) return;
      const r = canvas.getBoundingClientRect();
      if (e.pointerType === "mouse") this.pointer.set(
        (e.clientX - r.left) / r.width - 0.5,
        (e.clientY - r.top) / r.height - 0.5,
      );
      if (this.dragging) {
        if (!this.canInspect) {
          this.dragging = false;
          return;
        }
        this.targetRotation = THREE.MathUtils.clamp(
          this.targetRotation + (e.clientX - previousX) * 0.004,
          -0.8,
          0.8,
        );
        previousX = e.clientX;
        return;
      }
      if (e.pointerType !== "mouse") return;
      if (this.reveal < 0.8 || this.detail > 0.2 || !this.loaded || !records.length) return;
      this.cursor.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      );
      this.raycaster.setFromCamera(this.cursor, this.camera);
      const hit = this.raycaster.intersectObjects(
        [this.instances[0], this.model],
        true,
      ).find((hit) => this.pickableCell(hit.instanceId === undefined ? this.selectedCell : this.cells[hit.instanceId]));
      canvas.style.cursor = hit ? "pointer" : "default";
      this.onHover?.(
        hit
          ? hit.instanceId !== undefined
            ? fileAtCell(this.cells[hit.instanceId])
            : fileAtSlot(this.selectedSlot)
          : null,
      );
    });
    canvas.addEventListener("pointerup", (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId !== activePointer) return;
      activePointer = null;
      this.dragging = false;
      if (cancelled) return;
      if (e.pointerType !== "mouse" && this.detail < 0.2 && this.reveal >= 0.8 && this.loaded) {
        const swipe = swipeDirection(e.clientX - startX, e.clientY - startY, performance.now() - started);
        if (swipe) { this.onNavigate?.(swipe.axis, swipe.direction); return; }
      }
      if (
        Math.hypot(e.clientX - startX, e.clientY - startY) > 6 ||
        this.detail > 0.2 ||
        this.reveal < 0.8 ||
        !this.loaded
        || !records.length
      )
        return;
      const r = canvas.getBoundingClientRect();
      this.cursor.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      );
      this.raycaster.setFromCamera(this.cursor, this.camera);
      const hit = this.raycaster.intersectObjects(
        [this.instances[0], this.model],
        true,
      ).find((hit) => this.pickableCell(hit.instanceId === undefined ? this.selectedCell : this.cells[hit.instanceId]));
      if (hit)
        this.onSelect?.(
          hit.instanceId !== undefined
            ? fileAtCell(this.cells[hit.instanceId])
            : fileAtSlot(this.selectedSlot),
          hit.instanceId !== undefined
            ? { ...this.cells[hit.instanceId] }
            : { ...this.selectedCell },
        );
    });
    canvas.addEventListener("pointercancel", (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId === activePointer) { activePointer = null; cancelled = true; this.dragging = false; }
    });
    canvas.addEventListener("lostpointercapture", (e) => {
      pointers.delete(e.pointerId);
      if (e.pointerId === activePointer) { activePointer = null; this.dragging = false; }
    });
    canvas.addEventListener("pointerleave", () => {
      this.pointer.set(0, 0);
      this.onHover?.(null);
    });
  }
  update(
    time: number,
    cinematic?: { reveal: number; lift: number; zoom: number; time: number; musicIntro?: boolean },
    render = true,
  ) {
    if (this.disposed) return;
    const realDt = Math.min(time - this.last || 0.016, 0.05);
    // Advance a shared animation timeline, preserving the authored intro and
    // reduced-motion response. Row lighting receives this same dt exactly once.
    const speed = musicLibrary && !cinematic && !this.reduced ? getMusicMotionSpeed() : 1;
    const dt = realDt * speed;
    this.last = time;
    this.clock = time;
    if (!this.loaded) return;
    if (this.themeTransition) {
      if (this.themeTransition.update(time, speed)) this.themeTransition = undefined;
      this.syncThemeStars();
    }
    const previewLift = musicLibrary ? MUSIC_PREVIEW_LIFT : 0.4;
    const overview = musicLibrary && !cinematic ? this.musicOverview.update(dt, this.reduced) : 0;
    const blend = 1 - Math.exp(-dt * (this.reduced ? 35 : 2.8));
    this.reveal = cinematic
      ? cinematic.reveal
      : THREE.MathUtils.lerp(this.reveal, this.targetReveal, blend);
    const inspecting = this.targetDetail && (!musicLibrary || this.musicPresentation.placed);
    const aligningSelection = musicLibrary && this.musicNavigationLift && this.returnY !== null;
    this.rotation = this.reduced
      ? inspecting ? this.targetRotation : 0
      : inspecting && !aligningSelection
        ? THREE.MathUtils.lerp(this.rotation, this.targetRotation, blend)
        : returnStep(this.rotation, dt, this.reduced);
    if (musicLibrary && !cinematic) {
      this.musicPresentation.returnWhenAligned(this.rotation === 0);
      this.targetDetail = Number(this.musicPresentation.holdsDetail);
    }
    const presentationProgress = musicLibrary && !cinematic
      ? THREE.MathUtils.clamp(this.musicPlacement.update(this.targetDetail, dt, this.reduced), 0, 1)
      : 0;
    const musicIntro = Boolean(musicLibrary && cinematic?.musicIntro);
    // Music stops before the film's second extraction/inspection shot. The
    // last 400 ms hold the exact interactive pose instead of cutting to it.
    const shot = musicIntro ? Math.min(cinematic!.time, 27.12) : cinematic?.time ?? 29.1;
    const introSettle = musicIntro ? ease((shot - 25.3) / 1.42) : 0;
    if (cinematic) {
      this.scanTime = shot;
      this.scanBlend = 1;
    } else {
      this.scanTime += dt;
      this.scanBlend *= Math.exp(-dt * 3);
    }
    if (this.looping && !cinematic) this.rebaseCoordinates();
    const chosen = this.cellPosition(this.selectedCell);
    const selectedRow = this.selectedCell.row;
    const selectedLane = this.selectedCell.lane;
    const navigationLift = musicLibrary && !cinematic && this.musicNavigationLift;
    // Independent lift ownership survives an interrupted return; fast motion
    // belongs only to detail navigation, never to the returning/archive phases.
    const detailNavigation = navigationLift && this.musicPresentation.placed;
    const archiveTracks = { rail: this.rail, column: this.columnCamera, shoulder: this.shoulder, lane: this.laneFocus };
    const archiveTargets = { rail: cinematic ? 0 : -2.17 - chosen.z,
      column: chosen.x, shoulder: selectedRow, lane: selectedLane };
    const archiveRates = { rail: this.reduced ? 35 : detailNavigation ? MUSIC_ALBUM_SWITCH_RATE : 3.7,
      column: this.reduced ? 35 : detailNavigation ? MUSIC_ALBUM_SWITCH_RATE : 3.7,
      shoulder: this.reduced ? 35 : detailNavigation ? MUSIC_ALBUM_SWITCH_RATE : 5,
      lane: this.reduced ? 35 : detailNavigation ? MUSIC_ALBUM_SWITCH_RATE : 4 };
    if (musicLibrary && !cinematic && !detailNavigation && this.musicArchiveMotion.active) {
      this.musicArchiveMotion.update(archiveTracks, dt, this.reduced);
    } else {
      damp(this.shoulder, archiveTargets.shoulder, archiveRates.shoulder, dt);
      damp(this.laneFocus, archiveTargets.lane, archiveRates.lane, dt);
      damp(this.columnCamera, archiveTargets.column, archiveRates.column, dt);
      damp(this.rail, archiveTargets.rail, archiveRates.rail, dt);
      this.musicArchiveMotion.observe(archiveTracks, archiveTargets, archiveRates);
    }
    if (detailNavigation && this.reduced) {
      this.shoulder = { value: selectedRow, velocity: 0 };
      this.laneFocus = { value: selectedLane, velocity: 0 };
      this.columnCamera = { value: chosen.x, velocity: 0 };
      this.rail = { value: -2.17 - chosen.z, velocity: 0 };
    }
    if (cinematic) {
      this.rail.value = musicIntro ? -2.17 - chosen.z : 0;
      this.rail.velocity = 0;
      this.lift.value = musicIntro
        ? THREE.MathUtils.lerp(extraction(shot), previewLift, introSettle)
        : extraction(shot);
      this.lift.velocity = 0;
      this.shoulder.value = selectedRow;
      if (musicIntro) this.shoulder.velocity = 0;
      this.laneFocus.value = selectedLane;
      this.laneFocus.velocity = 0;
      this.columnCamera.value = chosen.x;
      this.columnCamera.velocity = 0;
    }
    if (musicLibrary && this.musicArrayMode === "realistic") {
      this.musicRealColumns.update(dt, this.reduced || Boolean(cinematic));
    }
    // Keep the illuminated set near the origin. Lateral navigation is a track
    // movement of the whole array, just like the existing front/back rail.
    const trackX = cinematic && !musicIntro ? 0 : this.columnCamera.value;
    const center = {
      lane: this.columnCamera.value / COLUMN_SPACING + 2,
      row: (-this.rail.value - 2.17) / ROW_SPACING + 15.5,
    };
    for (let i = 0; i < this.positions.length; i++) {
      this.cells[i] =
        !musicIntro && (cinematic || !this.looping)
          ? poolCell(i, this.poolRows) : this.visibleMusicCell(i, center);
      this.positions[i].set(
        (this.cells[i].lane - 2) * COLUMN_SPACING,
        -4.6,
        (this.cells[i].row + this.musicColumnRowOffset(this.cells[i].lane) - 15.5) * ROW_SPACING,
      );
    }
    this.pulses = this.pulses.filter((p) => time - p.time < 3.2);
    const aligningCopy = this.outgoing.some((o) => o.returnY !== null);
    const idle =
      !cinematic &&
      !this.reduced &&
      this.targetReveal > 0 &&
      !this.targetDetail &&
      this.detail < 0.01 &&
      this.returnY === null &&
      !aligningCopy &&
      time - this.lastInteraction > 2.5;
    this.idleGain = cinematic
      ? 0
      : THREE.MathUtils.lerp(
          this.idleGain,
          idle ? 1 : 0,
          1 - Math.exp(-dt * (idle ? 0.8 : 4)),
        );
    this.pulseGain = THREE.MathUtils.lerp(
      this.pulseGain,
      this.targetDetail || this.returnY !== null || aligningCopy ? 0 : 1,
      1 - Math.exp(-dt * 8),
    );
    const field = (row: number, lane: number) => {
      if (musicIntro) {
        // Recenter the authored wave on whichever album the library selected.
        // The same looping cells, resting shoulders and lane weights are used
        // on both sides of the handoff, so no rows pop or change altitude.
        const opening = cinematicField(row - selectedRow + 12, lane - selectedLane + 2, shot);
        const resting = this.musicArrayMode === "realistic"
          ? this.musicRealColumnField(row, lane, time)
          : settlingWave(row - selectedRow, 26.56) * columnStrength(lane, selectedLane);
        return THREE.MathUtils.lerp(opening, resting, introSettle);
      }
      if (cinematic)
        return cinematicField(
          row,
          lane,
          shot,
          this.shoulder.value,
          this.laneFocus.value,
        );
      if (musicLibrary && this.musicArrayMode === "realistic") return this.musicRealColumnField(row, lane, time);
      let height =
        archiveWave(
          row + this.coordinateOrigin.row,
          lane + this.coordinateOrigin.lane,
          this.scanTime,
        ) *
          this.scanBlend +
        idleWave(
          row + this.coordinateOrigin.row,
          lane + this.coordinateOrigin.lane,
          time,
        ) *
          this.idleGain;
      if (!cinematic && !this.reduced) {
        let ripple = 0;
        for (const p of this.pulses) {
          const distance = Math.hypot(row - p.row, (lane - p.lane) * 2.2);
          const age = time - p.time;
          ripple +=
            (musicLibrary ? musicSelectionWave(distance, age) : this.selectionPulse(distance, age)) *
            (this.deferSelectionPulse ? rippleEnvelope(distance, age) : 1);
        }
        height += THREE.MathUtils.clamp(ripple, musicLibrary ? -0.24 : -0.6, musicLibrary ? 0.24 : 0.6) * this.pulseGain;
      }
      const distance = row - this.shoulder.value;
      return (
        height +
        settlingWave(distance, 26.56) *
          columnStrength(lane, this.laneFocus.value)
      );
    };
    const selectedBase = chosen.y + field(selectedRow, selectedLane);
    if (!cinematic) {
      if (this.returnY !== null && this.rotation !== 0) {
        this.lift.value = this.returnY - selectedBase;
        this.lift.velocity = 0;
      } else {
        this.returnY = null;
        if (navigationLift) {
          // Placement stays at one throughout a detail switch. Giving the new
          // box its own spring lets it rise from its slot while its predecessor
          // returns, and preserves its actual height if Escape interrupts it.
          const aligningNeighbor = this.outgoing.some((o) => o.returnY !== null &&
            o.cell.lane === selectedLane && Math.abs(o.cell.row - selectedRow) < 5);
          const liftTarget = this.musicPresentation.placed
            ? !this.reduced && aligningNeighbor ? 0 : MUSIC_INSPECTION_LIFT
            : previewLift * this.targetReveal;
          if (this.reduced) this.lift = { value: liftTarget, velocity: 0 };
          else damp(this.lift, liftTarget, detailNavigation ? MUSIC_ALBUM_SWITCH_RATE : 4.2, dt);
        } else if (musicLibrary && (presentationProgress > 0 || !this.musicPlacement.settled || this.targetDetail)) {
          // The same progress also controls yaw, elevation, zoom and pan below.
          // Browsing keeps its own lift spring for selection ripples and copies.
          const restingLift = previewLift * this.targetReveal;
          this.lift.value = THREE.MathUtils.lerp(restingLift, MUSIC_INSPECTION_LIFT, presentationProgress);
          this.lift.velocity = this.musicPlacement.value === presentationProgress
            ? (MUSIC_INSPECTION_LIFT - restingLift) * this.musicPlacement.velocity : 0;
        } else damp(
          this.lift,
          this.targetDetail
            ? INSPECTION_LIFT
            : this.outgoing.some(
                  (o) =>
                    o.returnY !== null &&
                    o.cell.lane === selectedLane &&
                    Math.abs(o.cell.row - selectedRow) < 5,
                )
              ? 0
              : previewLift * this.targetReveal,
          this.reduced
            ? 35
            : this.deferSelectionPulse &&
                !this.targetDetail &&
                this.lift.value < 0.4
              ? 7.6
              : 4.2,
          dt,
        );
      }
    }
    const cameraTarget = this.targetDetail
      ? ease((this.lift.value - 0.8) / 2.4)
      : this.returnY !== null
        ? this.detail
        : ease((this.lift.value - previewLift) / (INSPECTION_LIFT - previewLift));
    this.detail = cinematic
      ? musicIntro ? 0 : musicLibrary ? musicCinematicPose(shot).detail : cinematic.zoom
      : musicLibrary ? presentationProgress : THREE.MathUtils.lerp(this.detail, cameraTarget, blend);
    const detail = this.detail;
    this.decryption.update(dt, detail > .78 && this.lift.value > 3.3, this.reduced,
      cinematic ? shot + 5 : undefined);
    this.appearance.apply(this.model, ease(this.lift.value / 0.4));
    this.appearance.setClarity(this.model, this.decryption.clarity);
    // Reference 26.92–27.76: the array travels horizontally into a white field.
    const entry = cinematic ? ease((shot - 21.9) / 0.86) : this.reveal;
    const entranceTime = THREE.MathUtils.clamp((shot - 21.92) / 0.75, 0, 1);
    const entryZ = cinematic
      ? -23 * (1 - entranceTime) ** 2
      : -28 * (1 - entry);
    for (let i = this.outgoing.length - 1; i >= 0; i--) {
      const o = this.outgoing[i];
      const p = this.cellPosition(o.cell);
      const baseY = p.y + field(o.cell.row, o.cell.lane);
      o.group.rotation.y = detailNavigation && this.reduced ? 0 : returnStep(o.group.rotation.y, dt, this.reduced);
      if (detailNavigation && this.reduced) {
        o.returnY = null;
        o.lift = { value: 0, velocity: 0 };
      } else if (o.returnY !== null) {
        o.lift.value = o.returnY - baseY;
        o.lift.velocity = 0;
        if (o.group.rotation.y === 0) o.returnY = null;
      } else damp(o.lift, 0, this.reduced ? 35 : detailNavigation ? MUSIC_ALBUM_SWITCH_RATE : 4.5, dt);
      o.group.position.set(
        p.x - trackX,
        baseY + o.lift.value,
        p.z + this.musicColumnRowOffset(o.cell.lane) * ROW_SPACING + entryZ + this.rail.value,
      );
      const quality = ease(o.lift.value / 0.4);
      this.appearance.apply(o.group, quality);
      o.clarity = this.reduced ? 0 : o.clarity * Math.exp(-dt * 9);
      this.appearance.setClarity(o.group, o.clarity);
      const { row, lane } = o.cell;
      o.group.rotation.x =
        (field(row + 0.5, lane) - field(row - 0.5, lane)) *
        0.024 *
        (1 - detail) *
        (1 - quality);
      this.applyMusicColumnExtent(o.group, cinematic ? 1 : this.musicColumnExtent(o.cell.lane));
      if (o.lift.value < 0.0001 && Math.abs(o.group.rotation.y) < 0.0001) {
        this.scene.remove(o.group);
        this.appearance.dispose(o.group);
        this.outgoing.splice(i, 1);
      }
    }
    if (
      this.pendingPulse &&
      !cinematic &&
      !this.targetDetail &&
      this.targetReveal
    ) {
      const selectedY = selectedBase + this.lift.value;
      const oldCardsLower = this.outgoing.every(
        (old) =>
          old.cell.lane !== selectedLane ||
          Math.abs(old.cell.row - selectedRow) > 4 ||
          old.group.position.y + 0.015 < selectedY,
      );
      // The new file causes the wave: finish most of its rise and let nearby
      // outgoing files get below it before starting the outward pulse.
      if (this.lift.value >= 0.35 && this.returnY === null && oldCardsLower) {
        if (!this.reduced) this.emitPulse(this.pendingPulse);
        this.pendingPulse = null;
      }
    }
    // Resolve returning copies before restoring their array instances, avoiding
    // a missing file for one frame at the ownership handoff.
    const hidden = new Set(this.outgoing.map((o) => cellKey(o.cell)));
    hidden.add(cellKey(this.selectedCell));
    for (let i = 0; i < this.positions.length; i++) {
      const p = this.positions[i];
      const { row, lane } = this.cells[i];
      const slope = field(row + 0.5, lane) - field(row - 0.5, lane);
      this.dummy.position.set(
        p.x - trackX,
        p.y + field(row, lane),
        p.z + entryZ + this.rail.value,
      );
      this.dummy.rotation.set(slope * 0.024 * (1 - detail), 0, 0);
      const hiddenCell = !this.actualCell(this.cells[i]) || hidden.has(cellKey(this.cells[i])) ||
        (!musicIntro && (cinematic || !this.looping) && i >= (musicLibrary ? 5 * this.poolRows : 160));
      this.applyMusicColumnExtent(this.dummy, hiddenCell ? 0 : cinematic ? 1 : this.musicColumnExtent(lane));
      this.dummy.updateMatrix();
      for (const inst of this.instances) inst.setMatrixAt(i, this.dummy.matrix);
      if (musicLibrary && this.covers) {
        this.covers.array.setMatrixAt(i, this.dummy.matrix);
        this.covers.setSlot(i, records[fileAtCell(this.cells[i])]);
      }
    }
    for (const inst of this.instances) inst.instanceMatrix.needsUpdate = true;
    if (musicLibrary && this.covers) this.covers.array.instanceMatrix.needsUpdate = true;
    this.model.position.set(
      chosen.x - trackX,
      chosen.y + field(selectedRow, selectedLane) + this.lift.value,
      chosen.z + this.musicColumnRowOffset(selectedLane) * ROW_SPACING + entryZ + this.rail.value,
    );
    // Extraction only changes elevation. Reframing belongs to the camera.
    this.model.rotation.set(
      (field(selectedRow + 0.5, selectedLane) -
        field(selectedRow - 0.5, selectedLane)) *
        0.024 *
        (1 - detail) *
        (1 - ease(this.lift.value / 0.4)),
      cinematic ? 0 : this.rotation,
      0,
    );
    this.applyMusicColumnExtent(this.model, cinematic ? 1 : this.musicColumnExtent(selectedLane));
    // Measured from frame 787: X edge (382,-204), adjacent row (78,38).
    // The label vertical edge constrains height; the file base is occluded.
    // Do not calibrate field of view from the visible fragment of a file.
    const orbit = ease((shot - 22.6) / 1.6);
    const settle = ease((shot - 24.25) / 2.25);
    const navigationOrbit = musicLibrary && !cinematic
      ? this.musicCamera.navigation(this.columnCamera.velocity / COLUMN_SPACING,
          this.musicArrayMode === "realistic" ? 0 : this.rail.velocity / ROW_SPACING, detail, dt, this.reduced)
      : { yaw: 0, elevation: 0 };
    const yaw = THREE.MathUtils.degToRad(89 - 22 * orbit - 8 * settle) + navigationOrbit.yaw;
    const elevation = THREE.MathUtils.degToRad(
      3 + 40 * ease((shot - 21.96) / 0.22) - 8 * orbit - 16 * settle +
        (musicIntro ? 6 * introSettle : musicLibrary && !cinematic ? 6 : 0),
    ) + navigationOrbit.elevation;
    const span = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(10.8, 10.3, orbit),
      7.33,
      settle,
    );
    const distance = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(28 + 7 * orbit, 140, settle),
      72,
      detail,
    );
    const arrayAim = new THREE.Vector3(
      -1.091,
      THREE.MathUtils.lerp(-2.55 + 0.4 * orbit, -0.045, settle),
      THREE.MathUtils.lerp(2.48, 0.481, settle),
    );
    const cameraAim = arrayAim.clone();
    const viewDirection = new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(yaw) * Math.cos(elevation),
    );
    if (cinematic) {
      const earlyTurn = ease((shot - 27.3) / 1.3);
      const finalTurn = ease((shot - 28.6) / 5.4);
      const musicPose = musicCinematicPose(shot, THREE.MathUtils.radToDeg(yaw), THREE.MathUtils.radToDeg(elevation));
      const shotYaw = musicLibrary ? THREE.MathUtils.degToRad(musicPose.yaw)
        : yaw - THREE.MathUtils.degToRad(9 * earlyTurn + 32 * finalTurn);
      const shotElevation = musicLibrary ? THREE.MathUtils.degToRad(musicPose.elevation)
        : elevation - THREE.MathUtils.degToRad(1.5 * earlyTurn + 3.7 * finalTurn);
      viewDirection.set(
        -Math.sin(shotYaw) * Math.cos(shotElevation),
        Math.sin(shotElevation),
        Math.cos(shotYaw) * Math.cos(shotElevation),
      );
    } else if (musicLibrary) {
      // The archive rests at 25° above the cover; inspection stays at 20°.
      // Both angles use the extraction progress, with no separate pan phase.
      const detailYaw = THREE.MathUtils.degToRad(8);
      const inspectionYaw = THREE.MathUtils.lerp(yaw, detailYaw, detail);
      const inspectionElevation = THREE.MathUtils.lerp(elevation, MUSIC_DETAIL_ELEVATION, detail);
      viewDirection.set(
        -Math.sin(inspectionYaw) * Math.cos(inspectionElevation),
        Math.sin(inspectionElevation),
        Math.cos(inspectionYaw) * Math.cos(inspectionElevation),
      );
    } else {
      viewDirection
        .lerp(new THREE.Vector3(-0.277, 0.238, 0.931), detail)
        .normalize();
    }
    if (cinematic) {
      const pan = ease((shot - 25.4) / 0.95);
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      cameraAim.addScaledVector(
        right,
        -2.05 * (1 - pan) * ease((shot - 24.2) / 0.8),
      );
    }
    if (cinematic && shot >= 25.05 && shot <= 27.3) {
      // Frames 760–785: the camera carries the same physical column from the
      // right into the selected position while the neighboring crests subside.
      const pan = ease((shot - 25.4) / 1.05);
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const up = new THREE.Vector3()
        .crossVectors(viewDirection, right)
        .normalize();
      const pixelScale = 1080 / span;
      const anchorAim = this.model.position
        .clone()
        .add(musicLibrary
          ? new THREE.Vector3(-MUSIC_MODEL.width / 2, MUSIC_MODEL.center.y + MUSIC_MODEL.height / 2, 0)
          : new THREE.Vector3(-2.5, 3.7, 0));
      anchorAim.addScaledVector(
        right,
        -(THREE.MathUtils.lerp(840, 518, pan) - 960) / pixelScale,
      );
      anchorAim.addScaledVector(
        up,
        -(540 - THREE.MathUtils.lerp(340, 288, pan)) / pixelScale,
      );
      cameraAim.lerp(anchorAim, ease((shot - 25.05) / 0.35));
    }
    if (cinematic && shot > 27.3) {
      const close = ease((shot - 27.3) / 6.7);
      const extractionCamera = ease((shot - 27.3) / 1.25);
      const musicAnchor = musicLibrary ? musicExtractionAnchor(shot) : null;
      const screenX = musicAnchor?.x ?? THREE.MathUtils.lerp(
        518 - 98 * extractionCamera,
        618,
        close,
      );
      const screenY = musicAnchor?.y ?? THREE.MathUtils.lerp(
        296 + 34 * extractionCamera,
        287,
        close,
      );
      const pixelScale = 1080 / THREE.MathUtils.lerp(span, 5.9, detail);
      const right = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection)
        .normalize();
      const up = new THREE.Vector3()
        .crossVectors(viewDirection, right)
        .normalize();
      const anchorAim = this.model.position
        .clone()
        .add(musicLibrary
          ? new THREE.Vector3(-MUSIC_MODEL.width / 2, MUSIC_MODEL.center.y + MUSIC_MODEL.height / 2, 0)
          : new THREE.Vector3(-2.5, 3.7, 0));
      anchorAim.addScaledVector(right, -(screenX - 960) / pixelScale);
      anchorAim.addScaledVector(up, -(540 - screenY) / pixelScale);
      // The preceding shot already holds this corner. Starting again from the
      // array aim caused a visible camera jump at the extraction boundary.
      if (musicLibrary) cameraAim.copy(anchorAim);
      else cameraAim.lerp(anchorAim, ease((shot - 27.3) / 0.5));
      if (musicLibrary) {
        // The film ends face-on at the center. The menu placement is a later,
        // separately gated camera move, after this shot has actually settled.
        const centerAim = this.model.position.clone().add(new THREE.Vector3().copy(MUSIC_MODEL.center));
        cameraAim.lerp(centerAim, musicCinematicPose(shot).centered);
      }
    }
    const width = this.container.clientWidth, height = this.container.clientHeight;
    const framing = archiveFraming(width, height, span, detail,
      this.container.closest<HTMLElement>("[data-layout]")?.dataset.layout === "compact");
    const right = new THREE.Vector3()
      .crossVectors(new THREE.Vector3(0, 1, 0), viewDirection).normalize();
    const up = new THREE.Vector3().crossVectors(viewDirection, right).normalize();
    const previewShift = new THREE.Vector3();
    if (musicLibrary) {
      const offset = musicArchiveOffset(width, height);
      previewShift.addScaledVector(right, offset.x * framing.span * width / Math.max(1, height));
      previewShift.addScaledVector(up, offset.y * framing.span);
    }
    if (musicIntro) {
      // Keep the film's corner tracking early, then release it smoothly to
      // the existing browsing composition, including the portrait endpoint.
      const previewAim = arrayAim.clone();
      if (framing.portrait) {
        previewAim.set(0, -4.6 + settlingWave(0, 26.56) + 0.4 + 1.85, -2.17);
        previewAim.addScaledVector(up, (framing.previewY - 0.5) * framing.span);
      }
      previewAim.add(previewShift);
      cameraAim.lerp(previewAim, introSettle);
    }
    if (!cinematic) {
      const pixelScale = height / framing.span;
      if (framing.portrait) {
        // Keep the preview camera independent of the live lift, wave and rail.
        // Following model.position here would visually cancel those motions.
        const previewAim = new THREE.Vector3(0, -4.6 + settlingWave(0, 26.56) + 0.4 + 1.85, -2.17);
        previewAim.addScaledVector(up, (framing.previewY - 0.5) * height / pixelScale);
        cameraAim.copy(previewAim);
      }
      cameraAim.add(previewShift);
      // The array rail moves around a fixed inspection slot. Following the new
      // model position here would first chase its adjacent slot, then reverse
      // when that slot reaches the camera; following its lift cancels extraction.
      const detailAim = musicLibrary
        ? new THREE.Vector3(0, -4.6 + settlingWave(0, 26.56) + MUSIC_INSPECTION_LIFT + MUSIC_MODEL.center.y, -2.17)
        : this.model.position.clone().add(new THREE.Vector3(0, 1.85, 0));
      const detailX = musicLibrary ? framing.portrait ? 0.5 : 0.25 : framing.detailX;
      detailAim.addScaledVector(right, (0.5 - detailX) * width / pixelScale);
      detailAim.addScaledVector(up, (framing.detailY - 0.5) * height / pixelScale);
      cameraAim.lerp(detailAim, detail);
    }
    if (overview > 0) {
      const wide = overviewFraming(width, height);
      const yaw = THREE.MathUtils.degToRad(wide.yaw), elevation = THREE.MathUtils.degToRad(wide.elevation);
      viewDirection.lerp(new THREE.Vector3(-Math.sin(yaw) * Math.cos(elevation),
        Math.sin(elevation), Math.cos(yaw) * Math.cos(elevation)), overview).normalize();
      cameraAim.lerp(new THREE.Vector3(0, -1.8, -1.5), overview);
      framing.span = THREE.MathUtils.lerp(framing.span, wide.span, overview);
    }
    const cameraPosition = cameraAim
      .clone()
      .addScaledVector(viewDirection, THREE.MathUtils.lerp(distance, overviewFraming(width, height).distance, overview));
    if (!cinematic && !this.reduced && (!musicLibrary || !this.musicPresentation.holdsDetail)) {
      cameraPosition.x += this.pointer.x * 0.12;
      cameraPosition.y -= this.pointer.y * 0.12;
    }
    if (musicLibrary && !cinematic) {
      this.musicCamera.update(this.camera, this.cameraAim, cameraPosition, cameraAim,
        framing.span, dt, this.reduced);
      const detailTarget = this.musicPresentation.holdsDetail ? 1 : 0;
      const liftTarget = this.musicPresentation.holdsDetail ? MUSIC_INSPECTION_LIFT : previewLift * this.targetReveal;
      const tracksSettled = musicArchiveTracksSettled(
        { rail: this.rail, column: this.columnCamera, shoulder: this.shoulder, lane: this.laneFocus },
        { rail: -2.17 - chosen.z, column: chosen.x, shoulder: selectedRow, lane: selectedLane });
      this.musicPresentation.update(dt,
        this.musicCamera.isSettled(this.camera, this.cameraAim, cameraPosition, cameraAim, framing.span),
        this.musicPlacement.settled && this.musicArchiveMotion.settled && tracksSettled &&
          (this.musicArrayMode !== "realistic" || this.musicRealColumns.settled(selectedLane)) && Math.abs(this.detail - detailTarget) < 0.001 && Math.abs(this.lift.value - liftTarget) < 0.008 &&
          Math.abs(this.rotation) < 0.001 && Math.abs(this.lift.velocity) < 0.025,
        this.reduced);
      this.targetDetail = Number(this.musicPresentation.holdsDetail);
      if (this.musicPresentation.phase === "archive") this.musicNavigationLift = false;
    } else {
      const cameraBlend = cinematic ? 1 : 1 - Math.exp(-dt * 5);
      this.camera.position.lerp(cameraPosition, cameraBlend);
      this.cameraAim.lerp(cameraAim, cameraBlend);
      this.camera.lookAt(this.cameraAim);
      this.camera.fov = THREE.MathUtils.lerp(
        this.camera.fov,
        THREE.MathUtils.radToDeg(
          2 * Math.atan((cinematic && !musicIntro ? THREE.MathUtils.lerp(span, 5.9, detail) : framing.span) / (2 * distance)),
        ),
        cameraBlend,
      );
      if (musicLibrary) this.musicCamera.observe(this.camera, this.cameraAim, dt);
    }
    const fog = this.scene.fog as THREE.Fog;
    // The camera position is damped after its target distance changes. Anchor
    // fog to the rendered camera, or entry puts the array behind the far plane
    // until the camera catches up (a brief white wash that exit never showed).
    const renderedDistance = this.camera.position.distanceTo(this.cameraAim);
    fog.near = renderedDistance + THREE.MathUtils.lerp(5, -1, detail);
    fog.far = renderedDistance + THREE.MathUtils.lerp(25, 12, detail);
    if (this.stars?.visible) {
      const depth = renderedDistance + 38;
      this.stars.position.copy(this.camera.position).addScaledVector(this.camera.getWorldDirection(new THREE.Vector3()), depth);
      this.stars.quaternion.copy(this.camera.quaternion);
      const halfHeight = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * depth;
      this.stars.scale.set(halfHeight * this.camera.aspect, halfHeight, 1);
    }

    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    let neighborTop = -Infinity;
    const boxTop = musicLibrary ? MUSIC_MODEL.center.y + MUSIC_MODEL.height / 2 : 3.76;
    const boxBottom = musicLibrary ? MUSIC_MODEL.center.y - MUSIC_MODEL.height / 2 : 0;
    const lane = selectedLane,
      row = selectedRow;
    for (let r = row - 5; r <= row + 5; r++) {
      if (r !== row)
        neighborTop = Math.max(neighborTop, -4.6 + field(r, lane) + boxTop);
    }
    for (const o of this.outgoing) {
      if (o.cell.lane === lane && Math.abs(o.cell.row - row) <= 5) {
        neighborTop = Math.max(neighborTop, o.group.position.y + boxTop);
      }
    }
    this.clearance = this.model.position.y + boxBottom - neighborTop;
    this.canInspect =
      !cinematic &&
      (!musicLibrary || this.musicPresentation.phase === "presented") &&
      Boolean(this.targetDetail) &&
      detail > 0.9 &&
      this.pulseGain < 0.01 &&
      this.clearance > (musicLibrary ? 0.05 : 0.3);
    this.container.dataset.inspection =
      this.returnY !== null
        ? "aligning"
        : this.canInspect
          ? "ready"
          : this.targetDetail
            ? "lifting"
            : "preview";
    const focalPoint = this.model.position
      .clone()
      .add(new THREE.Vector3(0, 2, 0))
      .applyMatrix4(this.camera.matrixWorldInverse);
    const bokehUniforms = this.bokeh.uniforms as Record<
      string,
      { value: number }
    >;
    bokehUniforms.focus.value = -focalPoint.z;
    bokehUniforms.aperture.value =
      (THREE.MathUtils.lerp(0.0003, 0.0008, detail) *
        this.quality.depthOfField) /
      100;
    this.renderer.info.reset();
    this.selectionLighting?.update(this.model, this.camera, dt,
      musicLibrary && records.length > 0 && this.model.visible, this.reduced, Boolean(cinematic), this.detail, {
        row: selectedRow + this.coordinateOrigin.row,
        lane: selectedLane + this.coordinateOrigin.lane,
        introTime: musicIntro ? shot : undefined,
        independentColumns: this.musicArrayMode === "realistic",
      });
    // AO normals and bokeh depth render this scene again without moving it.
    // Music frames share the first pass's shadows; the archive reference keeps
    // Three's original automatic updates. Animated casters still update each frame.
    this.renderer.shadowMap.autoUpdate = !musicLibrary;
    if (musicLibrary && this.renderer.shadowMap.enabled)
      this.renderer.shadowMap.needsUpdate = true;
    if (render) {
      this.covers?.flushUploads(this.renderer);
      this.composer.render();
    }
  }
  /** Compile and populate the real pipeline while the loading surface is up.
   * The introduction's clock starts only after this resolves. */
  async prepareMusicRenderer() {
    if (!musicLibrary || !this.loaded || this.disposed) return;
    const started = performance.now();
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    // The settled shot exercises both the instanced shelf and selected shell.
    const settled = { reveal: 1, lift: 0, zoom: 0, time: 27.12, musicIntro: true };
    this.update(started / 1000, settled, false);
    const visible = this.model.visible;
    this.model.visible = true;
    await this.renderer.compileAsync(this.scene, this.camera);
    this.model.visible = visible;
    if (this.disposed) return;
    // A slow artwork provider must not block the first usable frame.
    await this.covers?.prepareVisible(120);
    if (this.covers && this.covers.getStats().dirtyTiles) {
      this.covers.flushUploads(this.renderer, 32);
      await nextFrame();
    }
    // Real draws initialize transmission, shadow, AO and depth-of-field targets.
    // They cannot be warmed by compiling the main scene's materials alone.
    for (let i = 0; i < 2; i++) {
      if (this.disposed) return;
      this.update(performance.now() / 1000, settled);
      await nextFrame();
    }
    if (this.disposed) return;
    this.setMode("hidden");
    this.container.dataset.startupPreparation = JSON.stringify({
      milliseconds: Math.round(performance.now() - started),
      parallelCompile: this.renderer.extensions.has("KHR_parallel_shader_compile"),
      glError: this.renderer.getContext().getError(),
      covers: this.covers?.getStats(),
    });
  }
  /** Release GPU ownership on reload, instead of waiting for tab/process GC. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loaded = false;
    this.covers?.dispose();
    this.covers = undefined;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          materials.add(material);
          for (const value of Object.values(material))
            if (value instanceof THREE.Texture && !value.isRenderTargetTexture) textures.add(value);
        }
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
    this.labelTexture?.dispose();
    this.scene.environment?.dispose();
    this.light.shadow.dispose();
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
    this.scene.clear();
    this.outgoing = [];
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
  projectCard(x: number, y: number) {
    this.model.updateMatrixWorld(true);
    const p = this.model
      .localToWorld(new THREE.Vector3(x, y, 0.255))
      .project(this.camera);
    return [(p.x + 1) * this.container.clientWidth / 2, (1 - p.y) * this.container.clientHeight / 2];
  }
  get decryptionFrame() { return this.decryption.frame; }
  finishDecryption() { this.decryption.finish(); }
  get detailVisibility() {
    return ease((this.detail - 0.25) / 0.55);
  }
  get musicPresentationReady() { return this.loaded && this.musicPresentation.phase === "presented"; }
  get musicArchiveReady() { return this.loaded && this.musicPresentation.phase === "archive"; }
  get musicArchiveInteractive() {
    // A new selection gets a fresh browsing lift. Do not transfer the outgoing
    // album's remaining extraction progress to that newly selected box.
    return this.loaded && (this.musicPresentation.phase === "archive" ||
      (this.musicPresentation.phase === "returning-array" && this.musicPlacement.settled &&
        this.detail === 0 && Math.abs(this.rotation) < 0.02));
  }
  get musicPresentationPhase() { return this.musicPresentation.phase; }
  getStats() {
    this.model.updateMatrixWorld(true);
    const project = (x: number, y: number, z: number) => {
      const p = this.model
        .localToWorld(new THREE.Vector3(x, y, z))
        .project(this.camera);
      return [Math.round((p.x + 1) * this.container.clientWidth / 2), Math.round((1 - p.y) * this.container.clientHeight / 2)];
    };
    return {
      covers: this.covers?.getStats(),
      arrayMode: this.musicArrayMode,
      graphics: { geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures, programs: this.renderer.info.programs?.length,
        contextLost: this.renderer.getContext().isContextLost() },
      visibleAlbumCells: this.cells.filter((cell) => this.actualCell(cell)).length,
      uniqueAlbumCells: new Set(this.cells.filter((cell) => this.actualCell(cell)).map((cell) => fileAtCell(cell))).size,
      decryption: { ...this.decryption.frame, clarity: this.decryption.clarity },
      topLeft: project(-2.5, 3.7, 0),
      topRight: project(2.5, 3.7, 0),
      projectedCenter: project(0, MUSIC_MODEL.center.y, 0),
      labelTopLeft: project(-1.855, 3.27, 0.255),
      labelBottomLeft: project(-1.855, 2.81, 0.255),
      modelPosition: this.model.position
        .toArray()
        .map((v) => Math.round(v * 10000) / 10000),
      cameraPosition: this.camera.position
        .toArray()
        .map((v) => Math.round(v * 10000) / 10000),
      cameraAim: this.cameraAim.toArray().map((v) => Math.round(v * 10000) / 10000),
      fieldOfView: this.camera.fov,
      loaded: this.loaded,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      archiveCount: this.positions.length,
      returningFiles: this.outgoing.length,
      selectionPhase: this.pendingPulse
        ? "lifting"
        : this.pulses.length
          ? "wave"
          : "settled",
      pendingPulse: this.pendingPulse ? { ...this.pendingPulse } : null,
      pulses: this.pulses.map((pulse) => ({ ...pulse })),
      referenceTime: Math.round((this.scanTime + 5) * 100) / 100,
      selectedSlot: this.selectedSlot,
      selectedLane: Math.floor(this.selectedSlot / slotStride),
      selectedAlbumId: records[fileAtSlot(this.selectedSlot)]?.album?.id ?? null,
      albumCovers: this.covers?.array.visible ?? false,
      theme: this.theme,
      selectionLight: this.selectionLighting ? {
        experiment: this.selectionLighting.getExperiment(),
        ribbon: this.selectionLighting.getRowMotion(),
        visible: this.selectionLighting.spot.visible,
        position: this.selectionLighting.spot.position.toArray(),
        target: this.selectionLighting.spot.target.position.toArray(),
      } : null,
      selectedCell: { ...this.selectedCell },
      coordinateOrigin: { ...this.coordinateOrigin },
      poolBounds: {
        minLane: Math.min(...this.cells.map((c) => c.lane)),
        maxLane: Math.max(...this.cells.map((c) => c.lane)),
        minRow: Math.min(...this.cells.map((c) => c.row)),
        maxRow: Math.max(...this.cells.map((c) => c.row)),
      },
      laneFocus: this.laneFocus.value,
      columnCamera: this.columnCamera.value,
      rotation: this.rotation,
      clearance: this.clearance,
      canInspect: this.canInspect,
      returnPhase: this.returnY !== null ? "aligning" : "lowering",
      extraction: Math.round(this.lift.value * 1000) / 1000,
      previewLift: musicLibrary ? MUSIC_PREVIEW_LIFT : 0.4,
      appearance: Math.round(ease(this.lift.value / 0.4) * 1000) / 1000,
      cameraDetail: Math.round(this.detail * 1000) / 1000,
      musicPresentationPhase: this.musicPresentationPhase,
      musicPlacement: { progress: this.musicPlacement.value, velocity: this.musicPlacement.velocity,
        settled: this.musicPlacement.settled },
      musicArchiveMotion: { active: this.musicArchiveMotion.active, progress: this.musicArchiveMotion.progress,
        duration: this.musicArchiveMotion.durationSeconds, tracks: this.musicArchiveMotion.state },
      musicNavigationLift: this.musicNavigationLift,
      musicPresentationReady: this.musicPresentationReady,
      musicArchiveReady: this.musicArchiveReady,
      idleGain: this.idleGain,
      cameraDistance: this.camera.position.distanceTo(this.cameraAim),
      cameraNear: this.camera.near,
      cameraFar: this.camera.far,
      fogNear: (this.scene.fog as THREE.Fog).near,
      fogFar: (this.scene.fog as THREE.Fog).far,
      returningAppearance: this.outgoing.map((o) => ({
        slot: o.slot,
        cell: { ...o.cell },
        lift: o.lift.value,
        quality: ease(o.lift.value / 0.4),
        rotation: o.group.rotation.y,
        worldY: o.group.position.y,
        phase: o.returnY !== null ? "aligning" : "lowering",
      })),
      rail: Math.round(this.rail.value * 1000) / 1000,
    };
  }
}
