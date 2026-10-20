import "./music-lighting-lab.css";
import { DEFAULT_LIGHTING_PRESET, normalizeRowLighting } from "./music-row-lighting.ts";
import type { RowLightingMode, RowLightingSettings } from "./music-row-lighting.ts";

export type LightingLabMode = RowLightingMode;
export type LightingLabSettings = RowLightingSettings;
export type LightingLabController = { setEnabled: (enabled: boolean) => void; focus: () => void };

type LightingLabOptions = {
  setExperiment: (settings: LightingLabSettings) => void;
  initial?: Partial<LightingLabSettings>;
  enabled?: boolean;
  onChange?: (settings: LightingLabSettings) => void;
  onClose?: () => void;
};

const defaults = DEFAULT_LIGHTING_PRESET;

const approaches: Record<
  LightingLabMode,
  { label: string; detail: string; tradeoff: string }
> = {
  baseline: {
    label: "原版",
    detail: "保留原有环境光与封面照明，作为亮度对照。",
    tradeoff: "观察整排是否从相邻专辑中分离。",
  },
  area: {
    label: "条形灯",
    detail: "真实条形灯照亮玻璃顶边与端面。",
    tradeoff: "反光自然，但会照到邻排；封面不直接响应这盏灯。",
  },
  guided: {
    label: "排光场",
    detail: "整排高光保留，其他专辑按原版亮度补回。",
    tradeoff: "其他专辑亮度100%接近原版；降低可加强对比。",
  },
  hybrid: {
    label: "混合",
    detail: "用排光场控制明暗，再以条形灯补充壳体高光。",
    tradeoff: "兼顾清晰光带与反光层次，建议先比较。",
  },
};

const numericSettings = ["transitionDuration", "strength", "width", "offset", "fill"] as const;

/** Local, scene-independent controls. URL values take precedence over initial values. */
export function setupLightingLab(
  stage: HTMLElement,
  options: LightingLabOptions,
): LightingLabController {
  const params = new URLSearchParams(location.search);
  const initial = { ...options.initial };
  if (params.has("light")) initial.mode = params.get("light") as LightingLabMode;
  for (const key of numericSettings) {
    const value = params.get(key);
    if (value !== null && value !== "") initial[key] = Number(value);
  }
  const settings = normalizeRowLighting(initial, defaults);
  const panel = document.createElement("aside");
  panel.className = "lighting-lab";
  panel.hidden = !options.enabled;
  panel.setAttribute("aria-label", "光效开发者调试");
  panel.innerHTML = `
    <div class="lighting-lab-header">
    <button class="lighting-lab-heading" type="button" aria-controls="lighting-lab-controls" aria-expanded="true">
      <span><b>DEV</b> LIGHTING<small>光效调试 · V0.3.1</small></span>
      <span class="lighting-lab-chevron" aria-hidden="true">−</span>
    </button>
    <button class="lighting-lab-close" type="button" aria-label="关闭光效调试面板" title="关闭面板，保留效果">×</button>
    </div>
    <div id="lighting-lab-controls" class="lighting-lab-controls">
      <div class="lighting-lab-modes" role="group" aria-label="光照方式">
        <button type="button" data-light="baseline" aria-pressed="false"><b>0</b> 原版</button>
        <button type="button" data-light="area" aria-pressed="false"><b>A</b> 条形灯</button>
        <button type="button" data-light="guided" aria-pressed="false"><b>B</b> 排光场</button>
        <button type="button" data-light="hybrid" aria-pressed="false"><b>C</b> 混合</button>
      </div>
      <div class="lighting-lab-explanation" aria-live="polite">
        <p class="lighting-lab-detail"></p>
        <p class="lighting-lab-tradeoff"></p>
      </div>
      <div class="lighting-lab-sliders">
        <label for="lighting-lab-transition"><span>光带切换时长</span><output for="lighting-lab-transition"></output></label>
        <input id="lighting-lab-transition" data-setting="transitionDuration" type="range" min="0.4" max="2.4" step="0.05" aria-label="光带切换时长，秒">
        <p class="lighting-lab-timing-note">越大越舒缓；默认 ${defaults.transitionDuration.toFixed(2)} 秒。这里是 1× 下的时长，同时受整体切换速度调节。</p>
        <label for="lighting-lab-strength"><span>光照强度</span><output for="lighting-lab-strength"></output></label>
        <input id="lighting-lab-strength" data-setting="strength" type="range" min="0" max="2" step="0.05" aria-label="光照强度">
        <label for="lighting-lab-width"><span>光带宽度</span><output for="lighting-lab-width"></output></label>
        <input id="lighting-lab-width" data-setting="width" type="range" min="0.6" max="2.5" step="0.05" aria-label="光带宽度，排">
        <label for="lighting-lab-offset"><span>光带位置</span><output for="lighting-lab-offset"></output></label>
        <input id="lighting-lab-offset" data-setting="offset" type="range" min="-6" max="6" step="0.1" aria-label="光带位置，排">
        <label for="lighting-lab-fill"><span>其他专辑亮度</span><output for="lighting-lab-fill"></output></label>
        <input id="lighting-lab-fill" data-setting="fill" type="range" min="0" max="1" step="0.05" aria-label="其他专辑亮度，百分比">
      </div>
      <div class="lighting-lab-actions">
        <button class="lighting-lab-compare" type="button" aria-pressed="false">按住看原版</button>
        <button class="lighting-lab-reset" type="button">重置</button>
      </div>
      <p class="lighting-lab-detail-note">专辑详情沿用原选中光；返回专辑架后恢复排光对比。</p>
    </div>`;
  stage.append(panel);

  const heading = panel.querySelector<HTMLButtonElement>(
    ".lighting-lab-heading",
  )!;
  const controls = panel.querySelector<HTMLElement>(".lighting-lab-controls")!;
  const compare = panel.querySelector<HTMLButtonElement>(
    ".lighting-lab-compare",
  )!;
  const modeButtons = [
    ...panel.querySelectorAll<HTMLButtonElement>("[data-light]"),
  ];
  const sliders = [
    ...panel.querySelectorAll<HTMLInputElement>("[data-setting]"),
  ];
  const compactViewport = matchMedia("(max-width: 760px), (max-height: 650px)");
  let comparing = false;

  const syncExpanded = () => {
    const expanded = panel.dataset.expanded
      ? panel.dataset.expanded === "true"
      : !compactViewport.matches;
    heading.setAttribute("aria-expanded", String(expanded));
    panel.querySelector(".lighting-lab-chevron")!.textContent = expanded
      ? "−"
      : "+";
    if (!expanded) stopCompare();
  };

  function apply(writeUrl = true) {
    options.setExperiment({
      ...settings,
      mode: comparing ? "baseline" : settings.mode,
    });
    panel.dataset.mode = settings.mode;
    for (const button of modeButtons) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.light === settings.mode),
      );
    }
    const approach = approaches[settings.mode];
    panel.querySelector(".lighting-lab-detail")!.textContent = approach.detail;
    panel.querySelector(".lighting-lab-tradeoff")!.textContent =
      approach.tradeoff;
    const areaMode = settings.mode === "area";
    panel.querySelector('label[for="lighting-lab-width"] span')!.textContent =
      areaMode ? "灯面宽度" : "光带宽度";
    panel
      .querySelector("#lighting-lab-width")!
      .setAttribute("aria-label", areaMode ? "灯面宽度，倍" : "光带宽度，排");
    for (const input of sliders) {
      const key = input.dataset.setting as Exclude<
        keyof LightingLabSettings,
        "mode"
      >;
      const value = settings[key];
      input.value = String(value);
      input.disabled =
        settings.mode === "baseline" ||
        (key === "fill" && settings.mode !== "guided");
      const formatted =
        key === "transitionDuration"
          ? `${value.toFixed(2)} 秒`
          : key === "fill"
          ? `${Math.round(value * 100)}%`
          : key === "strength" || (key === "width" && areaMode)
            ? `${value.toFixed(2)}×`
            : `${key === "offset" && value > 0 ? "+" : ""}${value.toFixed(key === "width" ? 2 : 1)} 排`;
      panel.querySelector<HTMLOutputElement>(
        `output[for="${input.id}"]`,
      )!.value = formatted;
      input.setAttribute("aria-valuetext", formatted);
    }
    compare.disabled = settings.mode === "baseline";
    if (writeUrl) {
      const url = new URL(location.href);
      url.searchParams.set("light", settings.mode);
      for (const key of numericSettings) {
        url.searchParams.set(key, String(settings[key]));
      }
      history.replaceState(history.state, "", url);
      options.onChange?.({ ...settings });
    }
  }

  function startCompare() {
    if (comparing || settings.mode === "baseline") return;
    comparing = true;
    compare.setAttribute("aria-pressed", "true");
    compare.textContent = "原版 · 松开恢复";
    options.setExperiment({ ...settings, mode: "baseline" });
  }

  function stopCompare() {
    if (!comparing) return;
    comparing = false;
    compare.setAttribute("aria-pressed", "false");
    compare.textContent = "按住看原版";
    options.setExperiment({ ...settings });
  }

  heading.addEventListener("click", () => {
    panel.dataset.expanded = String(
      getComputedStyle(controls).display === "none",
    );
    syncExpanded();
  });
  panel.querySelector(".lighting-lab-close")!.addEventListener("click", () => {
    stopCompare();
    panel.hidden = true;
    options.onClose?.();
  });
  compactViewport.addEventListener("change", syncExpanded);
  modeButtons.forEach((button) =>
    button.addEventListener("click", () => {
      stopCompare();
      settings.mode = button.dataset.light as LightingLabMode;
      apply();
    }),
  );
  sliders.forEach((input) =>
    input.addEventListener("input", () => {
      const key = input.dataset.setting as Exclude<
        keyof LightingLabSettings,
        "mode"
      >;
      settings[key] = Number(input.value);
      apply();
    }),
  );
  panel.querySelector(".lighting-lab-reset")!.addEventListener("click", () => {
    stopCompare();
    Object.assign(settings, defaults);
    apply();
  });

  compare.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    compare.setPointerCapture(event.pointerId);
    startCompare();
  });
  for (const type of [
    "pointerup",
    "pointercancel",
    "lostpointercapture",
    "blur",
  ] as const) {
    compare.addEventListener(type, stopCompare);
  }
  compare.addEventListener("keydown", (event) => {
    if (event.code === "Space" || event.key === "Enter") {
      event.preventDefault();
      startCompare();
    }
  });
  compare.addEventListener("keyup", (event) => {
    if (event.code === "Space" || event.key === "Enter") {
      event.preventDefault();
      stopCompare();
    }
  });
  window.addEventListener("blur", stopCompare);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCompare();
  });

  // Inputs retain native keyboard/scroll behavior without moving the archive.
  for (const type of ["wheel", "pointerdown", "keydown", "keyup"] as const) {
    panel.addEventListener(type, (event) => {
      // Preserve the application's established Escape-to-shelf shortcut.
      if (event instanceof KeyboardEvent && event.key === "Escape") return;
      event.stopPropagation();
    });
  }

  syncExpanded();
  apply();
  return {
    setEnabled(enabled) {
      if (!enabled) {
        stopCompare();
      }
      panel.hidden = !enabled;
    },
    focus() {
      panel.hidden = false;
      panel.dataset.expanded = "true";
      syncExpanded();
      heading.focus({ preventScroll: true });
      panel.scrollIntoView({ block: "nearest" });
    },
  };
}
