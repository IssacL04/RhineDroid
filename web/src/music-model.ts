import * as THREE from "three";
import type { ThemeTransition } from "./theme-transition.ts";

// V0.4.0 is authored at its final dimensions by art/build-music-case.mjs.
// Keep the shelf/camera centre stable while rebuilding the shell construction.
export const MUSIC_MODEL = {
  width: 4.45,
  height: 3.35,
  depth: 0.14,
  center: { x: 0, y: 1.85, z: 0 },
} as const;

// A replaceable paper insert, inside the cover: rear tray < print < front lid.
// The plane never shares a depth with the cover or the retaining frame.
export const MUSIC_COVER = {
  width: 3.06,
  height: 3.06,
  x: 0.17,
  y: MUSIC_MODEL.center.y,
  z: 0.027,
} as const;

export const MUSIC_CASE_LAYERS = {
  rearFront: -0.032,
  print: MUSIC_COVER.z,
  lidBack: 0.052,
  lidFront: MUSIC_MODEL.depth / 2,
  spineRight: -1.875,
} as const;

type GlassFinish = Pick<THREE.MeshPhysicalMaterial,
  "transmission" | "thickness" | "roughness" | "attenuationDistance">;
const MUSIC_GLASS_FINISH: Record<string, {
  baseline: GlassFinish;
  day: GlassFinish;
  dayColor: string;
}> = {
  Frosted_Polymer: {
    baseline: { transmission: 0.96, thickness: 0.018, roughness: 0.34, attenuationDistance: 5 },
    day: { transmission: 0.94, thickness: 0.022, roughness: 0.4, attenuationDistance: 3.8 },
    dayColor: "#fffdf8",
  },
  Ivory_Edges: {
    // The reference spine transmits blurred shelf bands. A very high roughness
    // erases those bands into a flat white strip, even at high transmission.
    baseline: { transmission: 0.88, thickness: 0.06, roughness: 0.25, attenuationDistance: 4.5 },
    day: { transmission: 0.84, thickness: 0.08, roughness: 0.3, attenuationDistance: 3.2 },
    dayColor: "#e7e1d8",
  },
  Optical_Diffuser: {
    baseline: { transmission: 0.8, thickness: 0.038, roughness: 0.38, attenuationDistance: 4.5 },
    day: { transmission: 0.7, thickness: 0.05, roughness: 0.46, attenuationDistance: 2 },
    dayColor: "#ece6dc",
  },
};

export function normalizeMusicGeometry(geometry: THREE.BufferGeometry) {
  if (geometry.userData.musicDimensions) return geometry;
  // Compatibility entry point for scene/viewer ownership. No post-load scaling:
  // rounded corners, the inset seat and the cover gap are authored in one space.
  geometry.userData.musicDimensions = true;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** All music contexts share the same three physical materials and insert gap. */
export function configureMusicGlass(surface: string, material: THREE.MeshPhysicalMaterial) {
  material.color.set("#fffdfa");
  material.metalness = 0;
  material.envMapIntensity = 0.65;
  material.ior = 1.46;
  material.attenuationColor.set("#f3e9db");
  material.attenuationDistance = 4.5;
  material.clearcoat = surface === "Ivory_Edges" ? 0.16 : 0.08;
  material.clearcoatRoughness = surface === "Ivory_Edges" ? 0.2 : 0.38;
  material.transparent = false;
  material.opacity = 1;
  // Keep V0.4.0's single-sided transmission path while tuning the finish.
  material.side = THREE.FrontSide;
  const finish = MUSIC_GLASS_FINISH[surface];
  if (finish) Object.assign(material, finish.baseline);
  material.userData.musicShell = true;
  const compile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    compile.call(material, shader, renderer);
    shadeMusicGlass(shader, surface);
  };
  material.customProgramCacheKey = () => `music-case-v5-zoned-frost-${surface}`;
}

/**
 * Three's transmission mip estimate assumes distant contents. Our paper is
 * only .025 units behind an .018-unit lid. Keep the small footprint over that
 * insert, but let the uncovered glass diffuse the distant shelf behind it.
 * Local coordinates keep the finish attached to both instances and extracted
 * cases. A soft shoulder outside the insert prevents a visible square seam.
 * No normal noise, extra texture/pass, or change to the paper sampling is needed.
 */
export function shadeMusicGlass(shader: THREE.WebGLProgramParametersWithUniforms, surface: string) {
  if (surface !== "Frosted_Polymer" || shader.fragmentShader.includes("musicThinLid")) return;
  shader.vertexShader = "varying vec2 vMusicLidPosition;\n" + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace(
    "#include <begin_vertex>",
    "#include <begin_vertex>\nvMusicLidPosition = position.xy;",
  );
  shader.fragmentShader = `
    varying vec2 vMusicLidPosition;
    float musicPaperProximity() {
      vec2 paperEdge = abs(vMusicLidPosition - vec2(${MUSIC_COVER.x}, ${MUSIC_COVER.y}))
        - vec2(${MUSIC_COVER.width / 2}, ${MUSIC_COVER.height / 2});
      return 1.0 - smoothstep(0.015, 0.15, max(paperEdge.x, paperEdge.y));
    }
  ` + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <transmission_pars_fragment>",
    THREE.ShaderChunk.transmission_pars_fragment.replace(
      "float lod = log2( transmissionSamplerSize.x ) * applyIorToRoughness( roughness, ior );",
      `// musicThinLid: preserve nearby paper; diffuse the uncovered margin.
      float paperProximity = musicPaperProximity();
      float lod = log2( transmissionSamplerSize.x ) * applyIorToRoughness( roughness, ior )
        * mix(1.0, 0.04, paperProximity);`,
    ),
  );
}

/** Pale backgrounds need a little more body density and a readable matte rim. */
export function setMusicGlassTheme(
  surface: string,
  material: THREE.MeshPhysicalMaterial,
  day: boolean,
  transition: ThemeTransition,
) {
  const finish = MUSIC_GLASS_FINISH[surface];
  if (!material.userData.musicShell || !finish) return;
  const target = day ? finish.day : finish.baseline;
  for (const key of ["transmission", "thickness", "roughness", "attenuationDistance"] as const)
    transition.number(material, key, target[key]);
  // Night/dusk colors stay under the existing palette's theme control.
  if (day) transition.color(material.color, finish.dayColor);
}

export function musicAssemblyPart(surface: string) {
  if (surface === "Frosted_Polymer") return "cover";
  if (surface === "Optical_Diffuser") return "substrate";
  return "carrier";
}

/** Clarity softens the lid while the separate translucent spine keeps its finish. */
export function setMusicGlassClarity(material: THREE.MeshPhysicalMaterial, clarity: number, warmth = 0) {
  // Inspection softens the frosting slightly; it never becomes polished plastic.
  // The paper remains an independent, stable opaque print inside the lid.
  const daylight = THREE.MathUtils.clamp(warmth, 0, 1);
  material.roughness = THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(MUSIC_GLASS_FINISH.Frosted_Polymer.baseline.roughness,
      MUSIC_GLASS_FINISH.Frosted_Polymer.day.roughness, daylight),
    THREE.MathUtils.lerp(0.27, 0.34, daylight),
    THREE.MathUtils.clamp(clarity, 0, 1),
  );
}

export function createAlbumPrintMaterial(map: THREE.Texture) {
  // Matte ink receives the same diffuse lights and shadows as the archive.
  // It has no specular lobe, glow or glass layer to bleach the printed colours.
  const material = new THREE.MeshLambertMaterial({
    map,
    alphaTest: 0.025,
    toneMapped: false,
    fog: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <opaque_fragment>",
      // Keep strong key lighting within the print's original colour range.
      // A zero/weak diffuse light still produces a zero/dim print, unlike Basic.
      "outgoingLight = min(outgoingLight, diffuseColor.rgb);\n#include <opaque_fragment>",
    );
  };
  material.customProgramCacheKey = () => "album-diffuse-print-v4";
  return material;
}
