import "./music-lighting-lab.css";
import {
  DEFAULT_MUSIC_MOTION_SPEED,
  getMusicMotionSpeed,
  MAX_MUSIC_MOTION_SPEED,
  MIN_MUSIC_MOTION_SPEED,
  setMusicMotionSpeed,
} from "./music-motion-settings.ts";

type MotionLabOptions = {
  enabled: boolean;
  onChange: (speed: number) => void;
  onClose: () => void;
};

export function setupMotionLab(host: HTMLElement, options: MotionLabOptions) {
  const panel = document.createElement("aside");
  panel.className = "lighting-lab motion-lab";
  panel.hidden = !options.enabled;
  panel.setAttribute("aria-label", "动画速度开发者调试");
  panel.dataset.expanded = "true";
  panel.innerHTML = `
    <div class="lighting-lab-header">
      <button class="lighting-lab-heading" type="button" aria-controls="motion-lab-controls" aria-expanded="true">
        <span><b>DEV</b> MOTION<small>整体切换速度</small></span>
        <span class="lighting-lab-chevron" aria-hidden="true">−</span>
      </button>
      <button class="lighting-lab-close" type="button" aria-label="关闭动画速度调试面板" title="关闭面板，保留效果">×</button>
    </div>
    <div id="motion-lab-controls" class="lighting-lab-controls">
      <div class="lighting-lab-sliders">
        <label for="motion-lab-speed"><span>动画速度</span><output for="motion-lab-speed"></output></label>
        <input id="motion-lab-speed" type="range" min="${MIN_MUSIC_MOTION_SPEED}" max="${MAX_MUSIC_MOTION_SPEED}" step="0.05" aria-label="动画整体切换速度">
      </div>
      <div class="motion-lab-scale"><span>慢 · 0.25×</span><span>快 · 3×</span></div>
      <p class="lighting-lab-timing-note">专辑、镜头、文字与光带同步变速。光带实际时长 = 光效面板时长 ÷ 此倍率。歌曲播放和开场片头不变。</p>
      <p class="motion-lab-status" role="status">实时生效 · 自动保存在本机</p>
      <div class="lighting-lab-actions"><button class="motion-lab-reset" type="button">恢复 1×</button></div>
    </div>`;
  host.append(panel);
  const heading = panel.querySelector<HTMLButtonElement>(".lighting-lab-heading")!;
  const input = panel.querySelector<HTMLInputElement>("#motion-lab-speed")!;
  const output = panel.querySelector<HTMLOutputElement>("output")!;
  const sync = () => {
    const speed = getMusicMotionSpeed();
    input.value = String(speed);
    output.value = `${speed.toFixed(2)}×`;
    input.setAttribute("aria-valuetext", `${speed.toFixed(2)} 倍速`);
  };
  const expand = (expanded: boolean) => {
    panel.dataset.expanded = String(expanded);
    heading.setAttribute("aria-expanded", String(expanded));
    panel.querySelector(".lighting-lab-chevron")!.textContent = expanded ? "−" : "+";
  };
  const apply = (speed: number) => {
    setMusicMotionSpeed(speed);
    sync();
    options.onChange(getMusicMotionSpeed());
  };
  input.addEventListener("input", () => apply(Number(input.value)));
  panel.querySelector(".motion-lab-reset")!.addEventListener("click", () => apply(DEFAULT_MUSIC_MOTION_SPEED));
  heading.addEventListener("click", () => expand(panel.dataset.expanded !== "true"));
  panel.querySelector(".lighting-lab-close")!.addEventListener("click", () => {
    panel.hidden = true;
    options.onClose();
  });
  for (const type of ["wheel", "pointerdown", "keydown", "keyup"] as const) {
    panel.addEventListener(type, (event) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") return;
      event.stopPropagation();
    });
  }
  sync();
  return {
    setEnabled(enabled: boolean) { panel.hidden = !enabled; },
    focus() {
      panel.hidden = false;
      expand(true);
      heading.focus({ preventScroll: true });
      panel.scrollIntoView({ block: "nearest" });
    },
  };
}
