import { nativeCommand } from "./android-native";
import { archiveColumns, columnFiles, fileLocation, records } from "./data";
import { decryptionFrame, DECRYPTION_END, DECRYPTION_START } from "./decryption";
import { getMusicMotionSpeed, onMusicMotionSpeedChange } from "./music-motion-settings";
import { swipeDirection } from "./viewport-layout";
import { MUSIC_BOOT_SCENE_SPEED } from "./music-boot-timing";
import type { ArchiveCell, ArchiveNavigation } from "./archive-loop";
import type { MusicArrayMode } from "./music-array-layout";
import type { RenderQuality } from "./render-quality";
import type { OverviewColumn } from "./music-overview";

type State = {
  backend: string; phase: string; albumId: string; overview: number; framesSubmitted: number;
  width: number; height: number; visibleCells: number; uniqueCells: number;
  qualityScale?: number; renderWidth?: number; renderHeight?: number;
  virtualTime?: number; motionSpeed?: number; inspectionStart?: number;
  experimentalOptics?: boolean;
  focusDepth?: boolean;
  columns: { lane: number; x: number; y: number; count: number; row: number }[];
};

/** The native SurfaceView owns all 3D drawing; this object only passes UI events. */
export class NativeArchiveScene {
  onSelect?: (index: number, cell?: ArchiveCell) => void;
  onNavigate?: (axis: "row" | "lane", direction: number) => void;
  private state?: State;
  private selected = 0;
  private mode = "archive";
  private arrayMode: MusicArrayMode = "filled";
  private disposed = false;
  private failure?: Error;
  private controller = new AbortController();
  private waiters = new Set<() => void>();
  private gesture?: { id: number; x: number; y: number; time: number };
  private rotation = 0;
  private dragFrame = 0;
  private started = performance.now();
  private received = performance.now();
  private intro = false;
  private unsubscribeSpeed: () => void;

  constructor(private container: HTMLElement) {
    container.setAttribute("role", "img");
    container.style.touchAction = "none";
    const options = { signal: this.controller.signal };
    this.unsubscribeSpeed = onMusicMotionSpeedChange(value => this.command("scene-speed", { value }));
    this.command("scene-speed", { value: getMusicMotionSpeed() });
    window.addEventListener("rhine-native", ((event: CustomEvent) => {
      const value = event.detail;
      if (value?.type === "scene-state") {
        if (value.backend !== "VULKAN") { this.fail(new Error("没有建立 Vulkan 渲染后端")); return; }
        this.state = value;
        this.received = performance.now();
        for (const resolve of this.waiters) resolve();
      } else if (value?.type === "scene-pick") {
        const index = records.findIndex(record => record.id === value.albumId);
        if (index >= 0 && this.mode === "archive") this.onSelect?.(index, { lane: value.lane, row: value.row });
      } else if (value?.type === "scene-warning") this.container.dataset.renderWarning = value.error;
    }) as EventListener, options);
    container.addEventListener("pointerdown", event => {
      if (this.gesture || !event.isPrimary) return;
      this.gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now() };
      container.setPointerCapture(event.pointerId);
    }, options);
    container.addEventListener("pointermove", event => {
      if (this.gesture?.id !== event.pointerId || this.mode !== "detail") return;
      this.rotation = Math.max(-1.1, Math.min(1.1, (event.clientX - this.gesture.x) * .008));
      if (!this.dragFrame) this.dragFrame = requestAnimationFrame(() => {
        this.dragFrame = 0; this.command("scene-drag", { rotation: this.rotation });
      });
    }, options);
    container.addEventListener("pointerup", event => {
      const gesture = this.gesture;
      if (!gesture || gesture.id !== event.pointerId) return;
      this.gesture = undefined;
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      if (this.mode === "detail") return;
      const swipe = swipeDirection(dx, dy, performance.now() - gesture.time);
      if (swipe) this.onNavigate?.(swipe.axis, swipe.direction);
      else if (Math.hypot(dx, dy) < 12) {
        const box = container.getBoundingClientRect();
        const x = (event.clientX - box.left) / box.width, y = (event.clientY - box.top) / box.height;
        if (x >= 0 && x <= 1 && y >= 0 && y <= 1) this.command("scene-pick", { x, y });
      }
    }, options);
    for (const name of ["pointercancel", "lostpointercapture"])
      container.addEventListener(name, () => { this.gesture = undefined; }, options);
  }
  private fail(error: Error) {
    this.failure = error;
    this.container.dataset.renderError = error.message;
    this.container.dispatchEvent(new CustomEvent("rhine-scene-error", { detail: error.message, bubbles: true }));
    for (const resolve of this.waiters) resolve();
  }
  private command(type: string, data: Record<string, unknown> = {}) {
    if (!this.disposed) void nativeCommand(type, data).catch(error => this.fail(error));
  }
  async load(_url?: string, selected = 0) { await this.refreshLibrary(selected); }
  async refreshLibrary(selected = 0) {
    this.selected = selected;
    this.state = undefined;
    await nativeCommand("scene-library", { columns: archiveColumns.map((_, lane) =>
      columnFiles(lane).map(index => records[index].id)), selectedId: records[selected]?.id || "" });
  }
  async prepareMusicRenderer() {
    const deadline = performance.now() + 15000;
    this.command("scene-status");
    while (!this.disposed && (!this.state || this.state.framesSubmitted < 1)) {
      if (this.failure) throw this.failure;
      if (performance.now() > deadline) throw new Error("Vulkan 首帧提交超时，请重新打开应用");
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
        const timer = setTimeout(done, 200);
        this.waiters.add(done);
      });
    }
    if (this.failure) throw this.failure;
    this.container.dataset.startupPreparation = JSON.stringify({ backend: "VULKAN", verification: "frame-submission", framesSubmitted: this.state?.framesSubmitted,
      milliseconds: Math.round(performance.now() - this.started) });
  }
  select(index: number, navigation?: ArchiveNavigation, immediate = false) {
    if (!records[index]) return;
    this.selected = index;
    if (this.state) this.state.phase = this.mode === "detail" ? "placing" : "returning-array";
    this.command("scene-select", { albumId: records[index].id,
      ...immediate ? { immediate: true } : {},
      ...navigation && "axis" in navigation ? { axis: navigation.axis, direction: navigation.direction } : {} });
  }
  switchMusicAlbum(index: number, navigation?: ArchiveNavigation) { this.select(index, navigation); }
  setMode(mode: "hidden" | "archive" | "detail") {
    this.mode = mode;
    if (this.state) this.state.phase = mode === "detail" ? "placing" : "returning-array";
    this.command("scene-mode", { mode });
  }
  setMusicOverview(active: boolean) { this.command("scene-overview", { active }); }
  setMusicArrayMode(mode: MusicArrayMode) { this.arrayMode = mode; this.command("scene-array", { mode }); }
  setTheme(theme: string, animate = false) { this.command("scene-theme", { theme, immediate: !animate }); }
  setIdleMotion(value: boolean) { this.command("scene-idle", { value }); }
  setFocusDepth(value: boolean) { this.command("scene-focus", { value }); }
  setExperimentalOptics(value: boolean) { this.command("scene-optics", { value }); }
  setReduced(value: boolean) { this.command("scene-reduced", { value }); }
  setQuality(value: RenderQuality | boolean) {
    if (typeof value === "boolean") return;
    this.container.dataset.renderQuality = JSON.stringify({ ...value, backend: "VULKAN", antialias: "FXAA" });
    this.command("scene-quality", { scale: value.scale, pixelRatio: value.pixelRatio });
  }
  // Native materials have fixed lighting; the web-only lighting lab is never mounted in the APK.
  enableSelectionLighting() {}
  setLightingExperiment(settings: {strength?:number;width?:number;offset?:number;fill?:number;transitionDuration?:number}) {
    this.command("scene-lighting", {strength:settings.strength??1.3,width:settings.width??1.35,offset:settings.offset??.3,fill:settings.fill??1,transitionDuration:settings.transitionDuration??1.1});
  }
  resize() { /* The native Surface callback owns its viewport and reports the final size. */ }
  update(_time: number, cinema?: {musicIntro?:boolean;time:number}, _draw?: boolean) {
    if (cinema?.musicIntro && !this.intro) { this.intro = true; this.command("scene-intro", {time:cinema.time,speed:MUSIC_BOOT_SCENE_SPEED}); }
    else if (!cinema && this.intro) { this.intro = false; this.command("scene-intro", {active:false}); }
  }
  finishMusicIntro(_time: number) { this.showMusicArchiveImmediately(_time); }
  showMusicArchiveImmediately(_time: number) {
    this.intro = false;
    this.mode = "archive";
    this.command("scene-mode", { mode: "archive", immediate: true });
  }
  get musicPresentationPhase() { return this.state?.phase || "returning-array"; }
  get musicPresentationReady() { return this.musicPresentationPhase === "presented" && this.state?.albumId === records[this.selected]?.id; }
  get musicArchiveReady() { return this.musicPresentationPhase === "archive" && (!records.length || this.state?.albumId === records[this.selected]?.id); }
  get musicArchiveInteractive() { return this.mode === "archive" && ["archive","returning-array"].includes(this.musicPresentationPhase); }
  get musicOverviewProgress() { return this.state?.overview || 0; }
  get musicBrowseRow() { return fileLocation(this.selected).row; }
  musicBrowseRowForColumn(lane: number) {
    return this.arrayMode === "realistic" ? this.state?.columns.find(column => column.lane === lane)?.row ?? this.musicBrowseRow : this.musicBrowseRow;
  }
  musicColumnCell(lane: number, row: number): ArchiveCell { return { lane, row }; }
  get decryptionFrame() {
    const state=this.state;
    if (!state || this.mode!=="detail" || state.albumId!==records[this.selected]?.id) return decryptionFrame(-1);
    if (state.inspectionStart===undefined) return decryptionFrame(this.musicPresentationReady ? DECRYPTION_END : -1);
    if (state.inspectionStart<0) return decryptionFrame(-1);
    // A viewport transition must not re-mask an already inspected album; stale packets cannot consume a suspension.
    const extrapolation=Math.min(.2,Math.max(0,(performance.now()-this.received)/1000));
    const now=(state.virtualTime??0)+extrapolation*(state.motionSpeed??1);
    return decryptionFrame(DECRYPTION_START + Math.max(0,now-state.inspectionStart)*1.5);
  }
  getOverviewColumns(): OverviewColumn[] {
    const result = new Map<number, OverviewColumn>();
    for (const column of this.state?.columns || []) {
      const old = result.get(column.lane);
      const x = column.x * this.container.clientWidth;
      if (old && Math.abs(old.x - this.container.clientWidth / 2) < Math.abs(x - this.container.clientWidth / 2)) continue;
      result.set(column.lane, { ...column, x, y: column.y * this.container.clientHeight,
        name: archiveColumns[column.lane] || "", selected: column.lane === fileLocation(this.selected).lane });
    }
    return [...result.values()];
  }
  getStats() {
    return { backend: this.state?.backend || "INITIALIZING", framesSubmitted: this.state?.framesSubmitted || 0,
      graphics: { backend: this.state?.backend, width: this.state?.width, height: this.state?.height,
        qualityScale: this.state?.qualityScale, renderWidth: this.state?.renderWidth, renderHeight: this.state?.renderHeight,
        hardwareVulkanRequired: true, gpuInstancing: true },
      experimentalOptics: this.state?.experimentalOptics ?? false,
      focusDepth: this.state?.focusDepth ?? true,
      drawCalls: undefined, triangles: undefined, selectionLight: undefined, arrayMode: this.arrayMode,
      visibleAlbumCells: this.state?.visibleCells || 0, uniqueAlbumCells: this.state?.uniqueCells || 0, covers: { selectedSize: 512, atlasSize: "2048x2048" } };
  }
  dispose() {
    this.disposed = true;
    this.unsubscribeSpeed();
    this.controller.abort(); cancelAnimationFrame(this.dragFrame);
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}
