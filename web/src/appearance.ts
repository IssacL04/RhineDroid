import * as THREE from "three";
import { glassRevealGLSL, frostedTransmissionGLSL, FROSTED_ROUGHNESS } from "./glass-reveal.ts";
import { internalOpticsFragment } from "./internal-optics.ts";
import { setMusicGlassClarity, setMusicGlassTheme, shadeMusicGlass } from "./music-model.ts";
import { ThemeTransition } from "./theme-transition.ts";

import type { MusicSelectionLighting } from "./music-lighting";

type Surface = THREE.MeshPhysicalMaterial;
type Palette = { high: Surface; low?: Surface };

// The array and selected file share geometry. Morph their surface properties
// on one mesh so transparent shells never overlap during a quality change.
export class CardAppearance {
  musicLighting?: MusicSelectionLighting;
  private palettes = new Map<string, Palette>();
  private warmth = { value: 1 };

  register(name: string, high: Surface, low?: Surface) {
    // Capture the unthemed palette exactly once, before any interpolation.
    for (const mat of [high, low]) if (mat) {
      mat.userData.dayColor ??= mat.color.clone();
      mat.userData.dayAttenuation ??= mat.attenuationColor?.clone();
    }
    this.palettes.set(name, { high, low });
  }

  prepare(group: THREE.Group) {
    for (const child of group.children) {
      const mesh = child as THREE.Mesh;
      const name = mesh.userData.surface as string;
      const palette = this.palettes.get(name);
      if (!palette) continue;
      const mat = palette.high.clone();
      const amount = { value: 0 };
      const clarity = { value: 0 };
      mesh.material = mat;
      if (mat.userData.opticalOrder)
        mesh.renderOrder = mat.userData.opticalOrder;
      mesh.userData.appearance = amount;
      mesh.userData.glassClarity = clarity;
      mat.onBeforeCompile = (shader) => {
        if (mat.userData.opticalOrder)
          shader.fragmentShader = internalOpticsFragment(shader.fragmentShader);
        shader.uniforms.archiveQuality = amount;
        shader.uniforms.archiveClarity = clarity;
        shader.uniforms.archiveWarmth = this.warmth;
        shader.fragmentShader =
          "uniform float archiveQuality;\nuniform float archiveClarity;\nuniform float archiveWarmth;\n" +
          shader.fragmentShader;
        if (name === "Frosted_Polymer" && !mesh.userData.musicShell) {
          shader.vertexShader =
            "varying float vArchiveHeight;\nvarying vec2 vArchiveProjectedAxis;\n" + shader.vertexShader;
          shader.vertexShader = shader.vertexShader.replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>\nvArchiveHeight = position.y / 3.7;",
          );
          shader.fragmentShader =
            "varying float vArchiveHeight;\nvarying vec2 vArchiveProjectedAxis;\n" +
            glassRevealGLSL +
            shader.fragmentShader;
          shader.vertexShader = shader.vertexShader.replace(
            "#include <project_vertex>",
            "#include <project_vertex>\nvArchiveProjectedAxis = 1.85 * vec2(projectionMatrix[0][0] * modelViewMatrix[1][0], projectionMatrix[1][1] * modelViewMatrix[1][1]) / max(0.0001, abs(mvPosition.z));",
          );
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <transmission_pars_fragment>",
            (mesh.userData.keepFrosted
              ? frostedTransmissionGLSL.replace("panelPixels * 0.016", "panelPixels * 0.004")
              : frostedTransmissionGLSL) + "\n" + THREE.ShaderChunk.transmission_pars_fragment.replace(
              "float lod = log2( transmissionSamplerSize.x ) * applyIorToRoughness( roughness, ior );",
              "float lod = archiveTransmissionLod(roughness, ior, transmissionSamplerSize);",
            ),
          );
          if (!mesh.userData.keepFrosted) shader.fragmentShader = shader.fragmentShader.replace(
            "#include <color_fragment>",
            "#include <color_fragment>\nvec3 archiveTint = mix(mix(vec3(0.68, 0.76, 0.86), vec3(1.0), smoothstep(0.1, 1.0, vArchiveHeight)), mix(vec3(0.40, 0.30, 0.20), vec3(1.0, 0.98, 0.94), smoothstep(0.1, 1.0, vArchiveHeight)), archiveWarmth);\ndiffuseColor.rgb *= mix(archiveTint, vec3(1.0), archiveQuality);",
          );
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <roughnessmap_fragment>",
            `#include <roughnessmap_fragment>\nroughnessFactor = mix(mix(0.28, ${mesh.userData.keepFrosted ? 0.38 : FROSTED_ROUGHNESS}, archiveQuality), 0.025, glassRevealAtHeight(archiveClarity, vArchiveHeight));`,
          );
        } else if (!palette.low && !mesh.userData.musicShell) {
          // Stable screen-space coverage adds internal geometry without an
          // abrupt visibility toggle or a second transparent body.
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <color_fragment>",
            "#include <color_fragment>\nfloat coverage = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));\nif (archiveQuality <= coverage) discard;",
          );
        }
        if (mesh.userData.musicShell) shadeMusicGlass(shader, name);
        this.musicLighting?.shade(shader, name);
      };
      mat.customProgramCacheKey = () =>
        `archive-surface-clarity-${name}-${Boolean(palette.low)}-${Boolean(mesh.userData.keepFrosted)}-${Boolean(mesh.userData.musicShell)}`;
    }
  }

  setClarity(group: THREE.Group, value: number) {
    const clarity = THREE.MathUtils.clamp(value, 0, 1);
    // Traversal still works after the viewer reparents meshes into part groups.
    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.userData.glassClarity)
        return;
      if (child.userData.musicShell) {
        child.userData.glassClarity.value = clarity;
        if (child.userData.surface === "Frosted_Polymer")
          setMusicGlassClarity(child.material as Surface, clarity, this.warmth.value);
        return;
      }
      if (child.userData.keepFrosted) return;
      child.userData.glassClarity.value = clarity;
      if (child.userData.surface !== "Frosted_Polymer") return;
      const mat = child.material as Surface;
      const palette = this.palettes.get("Frosted_Polymer")!;
      const quality = child.userData.appearance.value as number;
      const baseline = (
        key: "thickness" | "transmission" | "attenuationDistance",
      ) =>
        THREE.MathUtils.lerp(
          palette.low?.[key] ?? palette.high[key],
          palette.high[key],
          quality,
        );
      mat.thickness = THREE.MathUtils.lerp(
        baseline("thickness"),
        0.018,
        clarity,
      );
      mat.transmission = THREE.MathUtils.lerp(
        baseline("transmission"),
        0.985,
        clarity,
      );
      mat.attenuationDistance = THREE.MathUtils.lerp(
        baseline("attenuationDistance"),
        8,
        clarity,
      );
    });
  }

  apply(group: THREE.Group, value: number) {
    for (const child of group.children) {
      const mesh = child as THREE.Mesh;
      const palette = this.palettes.get(mesh.userData.surface);
      if (!palette) {
        if (mesh.userData.albumCover) continue;
        // The printed canvas belongs to this file, including returning copies.
        (mesh.material as THREE.MeshBasicMaterial).opacity = value;
        continue;
      }
      mesh.userData.appearance.value = value;
      const { high, low } = palette;
      if (!low) continue;
      const mat = mesh.material as Surface;
      mat.color.copy(low.color).lerp(high.color, value);
      if (
        mat.attenuationColor &&
        low.attenuationColor &&
        high.attenuationColor
      ) {
        mat.attenuationColor
          .copy(low.attenuationColor)
          .lerp(high.attenuationColor, value);
        mat.attenuationDistance =
          Number.isFinite(low.attenuationDistance) &&
          Number.isFinite(high.attenuationDistance)
            ? THREE.MathUtils.lerp(
                low.attenuationDistance,
                high.attenuationDistance,
                value,
              )
            : high.attenuationDistance;
      }
      for (const key of [
        "roughness",
        "metalness",
        "transmission",
        "thickness",
        "clearcoat",
        "clearcoatRoughness",
      ] as const) {
        mat[key] = THREE.MathUtils.lerp(low[key] ?? 0, high[key] ?? 0, value);
      }
      // Keep the same transmission shader/pass throughout the transition.
      if (high.transmission > 0)
        mat.transmission = Math.max(0.000001, mat.transmission);
    }
  }

  setTheme(theme: "day" | "night" | "dusk", transition?: ThemeTransition) {
    const targets = transition ?? new ThemeTransition();
    targets.number(this.warmth, "value", theme === "day" ? 1 : 0);
    for (const [name, palette] of this.palettes) {
      for (const mat of [palette.high, palette.low]) {
        if (!mat) continue;
        if (theme === "day") {
          targets.color(mat.color, mat.userData.dayColor);
          if (mat.userData.dayAttenuation) targets.color(mat.attenuationColor, mat.userData.dayAttenuation);
        } else if (["Frosted_Polymer", "Ivory_Edges"].includes(name)) {
          targets.color(mat.color, theme === "night" ? "#f6fbff" : "#e6f0f2");
          if (mat.attenuationColor) targets.color(mat.attenuationColor, theme === "night" ? "#dceafd" : "#c8dbe1");
        } else if (name === "Optical_Diffuser") {
          targets.color(mat.color, theme === "night" ? "#c6d6e5" : "#91a4af");
        } else if (name === "Index_Inlay") targets.color(mat.color, theme === "night" ? "#d7e9ff" : "#b9d2df");
        setMusicGlassTheme(name, mat, theme === "day", targets);
      }
    }
    if (!transition) targets.finish();
  }

  dispose(group: THREE.Group) {
    for (const child of group.children) {
      const mesh = child as THREE.Mesh;
      const mat = mesh.material as THREE.MeshBasicMaterial;
      if (mesh.userData.albumCover) mesh.userData.coverDisposed = true;
      if (!mesh.userData.surface) mat.map?.dispose();
      mat.dispose();
    }
  }
}
