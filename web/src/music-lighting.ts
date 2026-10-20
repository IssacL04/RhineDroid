import * as THREE from "three";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { MUSIC_MODEL } from "./music-model.ts";
import { ThemeTransition } from "./theme-transition.ts";
import { DEFAULT_ROW_LIGHTING, followRowLight, introRowOffset, normalizeRowLighting, ROW_LIGHTING, ROW_LIGHTING_GLSL } from "./music-row-lighting.ts";
import type { RowLightingFrame, RowLightingSettings } from "./music-row-lighting.ts";
export type { RowLightingMode, RowLightingSettings } from "./music-row-lighting.ts";

/** Side key plus a bounded approximation of light scattered inside the CD shell. */
export class MusicSelectionLighting {
  readonly spot = new THREE.SpotLight("#ffe3b2", 180 * 64, 0, 0.32, 0.95, 2);
  readonly area = new THREE.RectAreaLight("#ffe3b2", 0, 39, 0.18);
  private experiment: RowLightingSettings = { ...DEFAULT_ROW_LIGHTING };
  // x: mode, y: strength, z: width in rows, w: offset in rows. Every material
  // shares these objects; selecting a variant never replaces/rebuilds a mesh.
  private readonly rowSettings = { value: new THREE.Vector4(0, 1, 1, 0) };
  private readonly rowDetail = { value: 0 };
  private readonly rowFill = { value: 1 };
  private readonly areaThemeIntensity = { value: 34 };
  private readonly areaAim = new THREE.Vector3();
  private readonly worldOrigin = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly anchor = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly anchorVelocity = new THREE.Vector3();
  private readonly columnVelocity = new THREE.Vector3();
  private initialized = false;
  private readonly column = { value: new THREE.Vector3() };
  private readonly rowColumn = { value: new THREE.Vector3() };
  private readonly rowMotion = { value: 0, velocity: 0 };
  private readonly laneMotion = { value: 0, velocity: 0 };
  private rowInitialized = false;
  private rowIntro = false;
  private rowBasis?: number;
  private rowBasisLane = 0;
  private independentColumns = false;
  private readonly scatterColor = { value: new THREE.Color("#ffdba3") };
  private readonly scatterStrength = { value: 1 };
  private readonly printAmbient = { value: 0.5 };
  private readonly shellBounds = { value: new THREE.Vector4(
    MUSIC_MODEL.center.x - MUSIC_MODEL.width / 2,
    MUSIC_MODEL.center.y - MUSIC_MODEL.height / 2,
    MUSIC_MODEL.center.y + MUSIC_MODEL.height / 2,
    1 / MUSIC_MODEL.height,
  ) };
  private readonly edgeFalloff = { value: new THREE.Vector2(1.7, 24) };

  constructor(private readonly scene: THREE.Scene) {
    this.spot.name = "Selected album soft key";
    // Existing soft contact shadows are sufficient; the local key adds no
    // second shadow-map render across the entire glass array.
    this.spot.castShadow = false;
    this.spot.visible = false;
    RectAreaLightUniformsLib.init();
    this.area.name = "V0.3.1 horizontal row area light";
    this.area.visible = false;
    this.area.castShadow = false;
    scene.add(this.spot, this.spot.target, this.area);
  }

  setExperiment(settings: Partial<RowLightingSettings>) {
    this.experiment = normalizeRowLighting(settings, this.experiment);
    const { mode, strength, width, offset, fill } = this.experiment;
    this.rowSettings.value.set(ROW_LIGHTING.modes[mode], strength, width, offset);
    this.rowFill.value = fill;
    this.updateAreaIntensity();
  }

  getExperiment(): RowLightingSettings { return { ...this.experiment }; }

  /** A rebuilt library begins a new logical coordinate space. */
  resetRowMotion() {
    this.rowInitialized = false;
    this.rowIntro = false;
    this.rowBasis = undefined;
    this.rowBasisLane = 0;
    this.independentColumns = false;
    this.rowMotion.velocity = this.laneMotion.velocity = 0;
  }

  getRowMotion() {
    return { row: this.rowMotion.value + this.experiment.offset, lane: this.laneMotion.value,
      opening: this.rowIntro, position: this.rowColumn.value.toArray() };
  }

  private updateAreaIntensity() {
    const { mode, strength } = this.experiment;
    const gain = mode === "area" ? 1 : mode === "hybrid" ? 0.3 : 0;
    this.area.intensity = this.areaThemeIntensity.value * strength * gain * (1 - this.rowDetail.value);
  }

  setTheme(theme: "day" | "night" | "dusk", key: THREE.DirectionalLight, transition?: ThemeTransition) {
    const night = theme === "night";
    const targets = transition ?? new ThemeTransition();
    targets.number(this.scene, "environmentIntensity", night ? 0.16 : 0.25);
    targets.number(key, "intensity", night ? 0.30 : 0.45);
    for (const child of this.scene.children) {
      if (child instanceof THREE.HemisphereLight) targets.number(child, "intensity", night ? 0.21 : 0.32);
      if (child instanceof THREE.DirectionalLight && child !== key) targets.number(child, "intensity", 0.045);
    }
    targets.color(this.spot.color, night ? "#dbe9ff" : "#ffe3b2");
    targets.color(this.area.color, night ? "#dbe9ff" : "#ffe3b2");
    targets.number(this.areaThemeIntensity, "value", night ? 24 : 34);
    targets.number(this.spot, "intensity", (night ? 130 : 180) * 64);
    targets.color(this.scatterColor.value, night ? "#cee5ff" : "#ffdba3");
    targets.number(this.scatterStrength, "value", night ? 0.72 : 1);
    targets.number(this.printAmbient, "value", night ? 0.12 : theme === "dusk" ? 0.38 : 0.5);
    if (!transition) targets.finish();
  }

  /** Diffuse printed art shares the moving light field, never the shell's glow.
   * All ownership states use world transforms, so changing instance/mesh cannot
   * change the exposure; extraction and return pass continuously through it.
   */
  shadePrint(shader: THREE.WebGLProgramParametersWithUniforms) {
    shader.uniforms.musicPrintLightColumn = this.column;
    shader.uniforms.musicPrintAmbient = this.printAmbient;
    shader.uniforms.musicRowSettings = this.rowSettings;
    shader.uniforms.musicRowDetail = this.rowDetail;
    shader.uniforms.musicRowFill = this.rowFill;
    shader.uniforms.musicRowColumn = this.rowColumn;
    shader.vertexShader = "varying vec3 vMusicPrintOrigin;\n" + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", `
      #include <begin_vertex>
      vec4 musicPrintOrigin = vec4(0.0, 0.0, 0.0, 1.0);
      #ifdef USE_INSTANCING
        musicPrintOrigin = instanceMatrix * musicPrintOrigin;
      #endif
      vMusicPrintOrigin = (modelMatrix * musicPrintOrigin).xyz;
    `);
    shader.fragmentShader = `
      varying vec3 vMusicPrintOrigin;
      uniform vec3 musicPrintLightColumn;
      uniform float musicPrintAmbient;
      ${ROW_LIGHTING_GLSL}
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", `
      // The low local key reaches nearby rows/lanes; the stacked shelf shelters
      // the rest. The lifted cover stays in the light while its neighbors fall
      // below it. This attenuation only removes diffuse light, never adds white.
      vec3 printDistance = (vMusicPrintOrigin - musicPrintLightColumn) / vec3(6.0, 3.35, 5.5);
      float printLight = exp(-dot(printDistance, printDistance));
      if (musicRowSettings.x < 0.5) {
      outgoingLight *= mix(musicPrintAmbient, 1.0, printLight);
      } else {
        // RectAreaLight is not evaluated by Three's Lambert material. The area
        // variant deliberately shows that architectural limit; it receives no
        // synthetic row mask. Guided variants redistribute existing diffuse
        // exposure by multiplication only, preserving ink hue and shadows.
        float rowField = musicRowField(vMusicPrintOrigin, musicRowColumn);
        float ambient = max(0.08, musicPrintAmbient * 0.5);
        // B restores the original spatial diffuse exposure outside the ribbon.
        // Fill 0 preserves the first experiment; fill 1 uses V0.3.0 as the floor.
        float baselineExposure = mix(musicPrintAmbient, 1.0, printLight);
        float fillAmount = musicRowSettings.x > 1.5 && musicRowSettings.x < 2.5 ? musicRowFill : 0.0;
        float fieldAmbient = mix(ambient, baselineExposure, fillAmount);
        float guidedGain = clamp(musicRowSettings.y * rowField, 0.0, 1.0);
        float fieldExposure = mix(fieldAmbient, 1.0, guidedGain);
        float areaExposure = mix(ambient, musicPrintAmbient, 0.25);
        float shelfExposure = musicRowSettings.x < 1.5 ? areaExposure : fieldExposure;
        // A lifted CD returns continuously to the proven inspection exposure.
        float detailExposure = mix(musicPrintAmbient, 1.0, printLight);
        outgoingLight *= mix(shelfExposure, detailExposure, musicRowDetail);
      }
      #include <opaque_fragment>
    `);
  }

  /** Shared by instances, the lifted CD and returning copies; no extra render pass.
   * WebGL transmission cannot propagate light between glass layers. This bounded
   * scattering term approximates that transport from the spine into the panel.
   */
  shade(shader: THREE.WebGLProgramParametersWithUniforms, surface: string) {
    // Covers are independent surface prints. Keep this guard even when a
    // caller accidentally registers them with the shell lighting controller.
    if (surface === "Album_Print") return;
    shader.uniforms.musicLightColumn = this.column;
    shader.uniforms.musicScatterColor = this.scatterColor;
    shader.uniforms.musicScatterStrength = this.scatterStrength;
    shader.uniforms.musicShellBounds = this.shellBounds;
    shader.uniforms.musicEdgeFalloff = this.edgeFalloff;
    shader.uniforms.musicRowColumn = this.rowColumn;
    shader.uniforms.musicRowSettings = this.rowSettings;
    shader.uniforms.musicRowDetail = this.rowDetail;
    shader.uniforms.musicRowFill = this.rowFill;
    const declarations = `
      varying vec3 vMusicLocal;
      varying vec3 vMusicOrigin;
    `;
    shader.vertexShader = declarations + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", `
      #include <begin_vertex>
      vMusicLocal = position;
      vec4 musicOrigin = vec4(0.0, 0.0, 0.0, 1.0);
      #ifdef USE_INSTANCING
        musicOrigin = instanceMatrix * musicOrigin;
      #endif
      vMusicOrigin = (modelMatrix * musicOrigin).xyz;
    `);
    shader.fragmentShader = declarations + `
      uniform vec3 musicLightColumn;
      uniform vec3 musicScatterColor;
      uniform float musicScatterStrength;
      // left X, bottom Y, top Y, inverse height — shared with the real shell.
      uniform vec4 musicShellBounds;
      uniform vec2 musicEdgeFalloff;
      ${ROW_LIGHTING_GLSL}
    ` + shader.fragmentShader;
    const glass = surface === "Frosted_Polymer";
    const spine = surface === "Ivory_Edges";
    shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", `
      vec3 musicOriginalOutgoing = outgoingLight;
      float laneDistance = abs(vMusicOrigin.x - musicLightColumn.x);
      float laneRadius = laneDistance / 3.2;
      float coreLight = exp(-laneRadius * laneRadius * laneRadius * laneRadius);
      float spillRadius = laneDistance / 7.2;
      float spillLight = exp(-spillRadius * spillRadius * spillRadius * spillRadius);
      // Both neighboring genre columns receive a broad, weaker wash. Two lanes
      // away it has almost vanished; only nearby rows carry the cross-shelf band.
      float laneLight = 0.58 * coreLight + 0.42 * spillLight;
      float rowDistance = (vMusicOrigin.z - musicLightColumn.z) / 5.5;
      float rowLight = exp(-rowDistance * rowDistance);
      float hotDistance = (vMusicOrigin.z - musicLightColumn.z) / 1.1;
      float hotLight = exp(-hotDistance * hotDistance);
      // The reference has a warm local ribbon, not uniformly glowing spines.
      float neighborDistance = (vMusicOrigin.z - musicLightColumn.z) / 2.4;
      float neighborLight = exp(-neighborDistance * neighborDistance);
      float guidedLight = 0.58 * coreLight * mix(0.12, 1.0, rowLight)
                        + 0.42 * spillLight * neighborLight;
      outgoingLight *= mix(0.96, 1.04, guidedLight);
      ${glass || spine ? `
        float fromSpine = max(0.0, vMusicLocal.x - musicShellBounds.x);
        float edgeTransport = exp(-fromSpine * musicEdgeFalloff.x);
        float panelHeight = clamp((vMusicLocal.y - musicShellBounds.y) * musicShellBounds.w, 0.0, 1.0);
        float lowerLight = mix(1.0, 0.62, panelHeight);
        float topRim = exp(-max(0.0, musicShellBounds.z - vMusicLocal.y) * musicEdgeFalloff.y);
        float grazing = 1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0);
        float edgeScatter = ${spine ? '0.30' : '0.14'} * edgeTransport + ${spine ? '0.016' : '0.003'};
        outgoingLight += musicScatterColor * musicScatterStrength * guidedLight * edgeScatter * lowerLight;
        // A narrow glint at the top and the lit spine changes with viewing angle.
        // Warm light stays on the glass; the independent cover has no such term.
        float ribbon = topRim * (0.22 + 0.78 * edgeTransport) + ${spine ? '0.18' : '0.035'} * edgeTransport * grazing;
        outgoingLight += musicScatterColor * musicScatterStrength * laneLight * hotLight * ribbon * 0.8;
      ` : ''}
      if (musicRowSettings.x > 0.5) {
        vec3 musicSelectedOutgoing = outgoingLight;
        outgoingLight = musicOriginalOutgoing;
        float rowField = musicRowField(vMusicOrigin, musicRowColumn);
        float rowGain = musicRowSettings.x > 1.5 ? rowField * musicRowSettings.y : 0.0;
        // The whole shell receives exposure contrast; the narrow rim below is
        // only a highlight, so the result does not reduce to yellow outlines.
        float fillAmount = musicRowSettings.x > 1.5 && musicRowSettings.x < 2.5 ? musicRowFill : 0.0;
        float shellAmbient = mix(0.56, mix(0.96, 1.04, guidedLight), fillAmount);
        float shelfExposure = mix(shellAmbient, 1.08, clamp(rowGain, 0.0, 1.0));
        outgoingLight *= shelfExposure;
        ${glass || spine ? `
          float fromSpine = max(0.0, vMusicLocal.x - musicShellBounds.x);
          float edgeTransport = exp(-fromSpine * musicEdgeFalloff.x);
          float topRim = exp(-max(0.0, musicShellBounds.z - vMusicLocal.y) * musicEdgeFalloff.y);
          float grazing = 1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0);
          float panelHeight = clamp((vMusicLocal.y - musicShellBounds.y) * musicShellBounds.w, 0.0, 1.0);
          float panelScatter = ${spine ? '0.30' : '0.12'} * edgeTransport + ${spine ? '0.05' : '0.025'};
          float rimScatter = topRim * (0.55 + 0.45 * edgeTransport) +
            ${spine ? '0.24' : '0.07'} * edgeTransport * grazing;
          float scatter = panelScatter * mix(1.0, 0.78, panelHeight) + rimScatter * 1.25;
          float hybridGain = musicRowSettings.x > 2.5 ? 0.86 : 1.0;
          outgoingLight += musicScatterColor * musicScatterStrength * rowGain *
            scatter * hybridGain;
        ` : ''}
        outgoingLight = mix(outgoingLight, musicSelectedOutgoing, musicRowDetail);
      }
      #include <opaque_fragment>
    `);
  }

  private follow(value: THREE.Vector3, velocity: THREE.Vector3, target: THREE.Vector3, dt: number) {
    const rate = 5.0;
    const decay = Math.exp(-rate * dt);
    for (const axis of ["x", "y", "z"] as const) {
      const delta = value[axis] - target[axis];
      const impulse = velocity[axis] + rate * delta;
      value[axis] = target[axis] + (delta + impulse * dt) * decay;
      velocity[axis] = (velocity[axis] - rate * impulse * dt) * decay;
    }
  }

  update(model: THREE.Object3D, camera: THREE.Camera, dt: number, visible: boolean, reduced: boolean, cinematic = false, detail = 0, frame?: RowLightingFrame) {
    this.spot.visible = visible;
    // Keep the light list stable across experiment modes. An intensity of zero
    // disables its energy without changing NUM_RECT_AREA_LIGHTS / shader cache.
    this.area.visible = visible;
    this.rowDetail.value = THREE.MathUtils.smoothstep(detail, 0, 1);
    this.updateAreaIntensity();
    if (!visible) {
      this.initialized = false;
      this.resetRowMotion();
      return;
    }
    // Keep the original broad key independent of the narrow positional ribbon.
    model.updateWorldMatrix(true, false);
    model.getWorldPosition(this.worldOrigin);
    const columnTarget = this.experiment.mode === "baseline" ? model.position : this.worldOrigin;
    this.aim.set(
      MUSIC_MODEL.center.x - MUSIC_MODEL.width / 2 + 0.14,
      MUSIC_MODEL.center.y + MUSIC_MODEL.height * 0.12,
      MUSIC_MODEL.center.z,
    ).applyMatrix4(model.matrixWorld);
    if (!this.initialized || reduced || cinematic) {
      // Opening choreography already eases its track/camera: another spring
      // would leave the light behind during the large initial array translation.
      this.anchor.copy(this.aim);
      this.column.value.copy(columnTarget);
      this.anchorVelocity.set(0, 0, 0);
      this.columnVelocity.set(0, 0, 0);
    } else {
      // Preserve velocity on repeated input. A critically damped start follows
      // the soft lift; the wider lane footprint crossfades neighboring columns
      // while travelling between them instead of extinguishing both midway.
      this.follow(this.anchor, this.anchorVelocity, this.aim, dt);
      this.follow(this.column.value, this.columnVelocity, columnTarget, dt);
    }
    this.initialized = true;
    const targetRow = frame?.row ?? this.worldOrigin.z / ROW_LIGHTING.rowSpacing;
    const targetLane = frame?.lane ?? this.worldOrigin.x / ROW_LIGHTING.laneSpacing;
    const independentColumns = frame?.independentColumns === true;
    const rowBasis = this.worldOrigin.z - targetRow * ROW_LIGHTING.rowSpacing;
    const opening = !reduced && frame?.introTime !== undefined;
    if (!this.rowInitialized || reduced || cinematic || this.rowIntro) {
      // Skipping an opening also lands directly on the selected row.
      this.rowMotion.value = targetRow;
      this.laneMotion.value = targetLane;
      this.rowMotion.velocity = this.laneMotion.velocity = 0;
    } else {
      if (this.rowBasis !== undefined && (independentColumns !== this.independentColumns ||
          (independentColumns && targetLane !== this.rowBasisLane))) {
        // Crossing independently centered shelves changes the meaning of an
        // absolute row. Carry the already displayed ribbon into the new basis.
        // Within a column its rail transform remains exact, never filtered twice.
        this.rowMotion.value += (this.rowBasis - rowBasis) / ROW_LIGHTING.rowSpacing;
      }
      followRowLight(this.rowMotion, targetRow, dt, this.experiment.transitionDuration);
      followRowLight(this.laneMotion, targetLane, dt, this.experiment.transitionDuration);
    }
    if (opening) this.rowMotion.value = targetRow + introRowOffset(frame!.introTime!);
    this.rowIntro = opening;
    this.rowInitialized = true;
    this.rowBasis = rowBasis;
    this.rowBasisLane = targetLane;
    this.independentColumns = independentColumns;
    // Follow inside the shelf, then add its current rendered transform exactly.
    // Filtering world z a second time would lag behind the moving rail and
    // illuminate a row beyond the target. Absolute rows survive pool rebasing.
    this.rowColumn.value.copy(this.worldOrigin);
    this.rowColumn.value.z += (this.rowMotion.value - targetRow) * ROW_LIGHTING.rowSpacing;
    this.rowColumn.value.x += (this.laneMotion.value - targetLane) * ROW_LIGHTING.laneSpacing;
    this.spot.target.position.copy(this.anchor);
    // Camera-local -X/-Y: light enters from the lower-left of the picture and
    // grazes the spine, rather than illuminating the album face from above.
    // The old near-field source sat inside a neighboring lane and burned a
    // white spot into its nearest corner. Move it eight times farther away,
    // outside the pool, and compensate intensity by distance squared above.
    this.offset.set(-6, -2.2, 4.5).multiplyScalar(8).applyQuaternion(camera.quaternion);
    this.spot.position.copy(this.anchor).add(this.offset);
    // The strip lies along world X and faces the upper front edge of the row.
    // A low, close emitter intentionally exposes real geometric spill: without
    // area-light shadows, it cannot produce the exact one-row cutoff of a mask.
    const rowZ = this.rowColumn.value.z + this.experiment.offset * ROW_LIGHTING.rowSpacing;
    const topY = this.rowColumn.value.y + MUSIC_MODEL.center.y + MUSIC_MODEL.height / 2;
    this.area.height = 0.18 * this.experiment.width;
    this.area.position.set(this.rowColumn.value.x, topY + 0.5, rowZ + 0.44);
    this.areaAim.set(this.rowColumn.value.x, topY - 0.25, rowZ);
    this.area.lookAt(this.areaAim);
  }
}
