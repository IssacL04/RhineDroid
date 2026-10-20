import * as THREE from "three";

export type ViewerThemeName = "day" | "night" | "dusk";
type SurfaceColor = { color: THREE.Color; attenuation?: THREE.Color };

function savedColor(value: unknown, fallback: THREE.Color) {
  if (value instanceof THREE.Color) return value.clone();
  if (typeof value === "string" || typeof value === "number")
    return new THREE.Color(value);
  if (
    value &&
    typeof value === "object" &&
    "r" in value &&
    "g" in value &&
    "b" in value
  ) {
    const color = value as { r: number; g: number; b: number };
    return new THREE.Color().setRGB(color.r, color.g, color.b);
  }
  return fallback.clone();
}

/** Opt-in theme changes; constructing this controller leaves the baseline intact. */
export class ViewerTheme {
  private theme: ViewerThemeName = "day";
  private colors = new WeakMap<THREE.MeshStandardMaterial, SurfaceColor>();
  private stars?: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly scene: THREE.Scene;
  private readonly renderer: Pick<THREE.WebGLRenderer, "toneMappingExposure">;
  private readonly keyLight: THREE.DirectionalLight;

  constructor(
    scene: THREE.Scene,
    renderer: Pick<THREE.WebGLRenderer, "toneMappingExposure">,
    keyLight: THREE.DirectionalLight,
  ) {
    this.scene = scene;
    this.renderer = renderer;
    this.keyLight = keyLight;
  }

  setTheme(theme: ViewerThemeName, model?: THREE.Object3D) {
    this.theme = theme;
    const background =
      theme === "night" ? "#07111f" : theme === "dusk" ? "#b9c7cc" : "#eae5e1";
    (this.scene.background as THREE.Color).set(background);
    if (this.scene.fog) this.scene.fog.color.set(background);
    this.renderer.toneMappingExposure = theme === "night" ? 1.08 : 1.05;
    this.scene.environmentIntensity = theme === "night" ? 0.68 : 0.48;
    this.keyLight.color.set(
      theme === "night" ? "#e5f0ff" : theme === "dusk" ? "#eff8ff" : "#fff7ed",
    );
    this.keyLight.intensity = theme === "night" ? 1.7 : 1.4;
    for (const light of this.scene.children)
      if (light instanceof THREE.HemisphereLight) {
        light.color.set(theme === "night" ? "#e2eeff" : "#fffaf5");
        light.groundColor.set(
          theme === "night"
            ? "#56708c"
            : theme === "dusk"
              ? "#718898"
              : "#b4a18c",
        );
        light.intensity = theme === "night" ? 0.9 : 0.65;
      }
    if (theme === "night" && !this.stars) this.createStars();
    if (this.stars) this.stars.visible = theme === "night";
    if (model) this.applyModel(model);
  }

  applyModel(model: THREE.Object3D) {
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || object.userData.albumCover) return;
      const surface = object.userData.surface as string | undefined;
      if (
        !surface ||
        ![
          "Frosted_Polymer",
          "Ivory_Edges",
          "Optical_Diffuser",
          "Index_Inlay",
        ].includes(surface)
      )
        return;
      for (const material of Array.isArray(object.material)
        ? object.material
        : [object.material]) {
        if (!(material instanceof THREE.MeshStandardMaterial)) continue;
        const physical =
          material instanceof THREE.MeshPhysicalMaterial ? material : undefined;
        let baseline = this.colors.get(material);
        if (!baseline) {
          // Models supplied by the main scene may already be in night mode.
          // Its palettes retain original day colors in material userData.
          baseline = {
            color: savedColor(material.userData.dayColor, material.color),
            attenuation: physical
              ? savedColor(
                  material.userData.dayAttenuation,
                  physical.attenuationColor,
                )
              : undefined,
          };
          this.colors.set(material, baseline);
        }
        if (this.theme === "day") {
          material.color.copy(baseline.color);
          if (physical && baseline.attenuation)
            physical.attenuationColor.copy(baseline.attenuation);
        } else if (surface === "Frosted_Polymer" || surface === "Ivory_Edges") {
          material.color.set(this.theme === "night" ? "#f6fbff" : "#e6f0f2");
          physical?.attenuationColor.set(
            this.theme === "night" ? "#dceafd" : "#c8dbe1",
          );
        } else if (surface === "Optical_Diffuser")
          material.color.set(this.theme === "night" ? "#c6d6e5" : "#91a4af");
        else if (surface === "Index_Inlay")
          material.color.set(this.theme === "night" ? "#d7e9ff" : "#b9d2df");
      }
    });
  }

  update(camera: THREE.PerspectiveCamera) {
    if (!this.stars?.visible) return;
    const depth = camera.position.length() + 12;
    this.stars.position
      .copy(camera.position)
      .addScaledVector(camera.getWorldDirection(new THREE.Vector3()), depth);
    this.stars.quaternion.copy(camera.quaternion);
    const halfHeight =
      (Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * depth) /
      camera.zoom;
    this.stars.scale.set(halfHeight * camera.aspect, halfHeight, 1);
  }

  private createStars() {
    let seed = 417;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const positions: number[] = [];
    for (let i = 0; i < 140; i++)
      positions.push(random() * 2 - 1, random() * 2 - 1, 0);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    this.stars = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: "#dbeaff",
        size: 1.5,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
        fog: false,
      }),
    );
    this.stars.frustumCulled = false;
    this.stars.name = "Viewer night sky";
    this.scene.add(this.stars);
  }
}
