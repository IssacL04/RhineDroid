import "@kitlangton/rolling-number/styles.css";
import "./style.css";
import "./quality-settings.css";
import "./document-decryption.css";
import "./decryption.css";
import "./music.css";
import "./music-navigation-motion.css";
import "./music-navigation-ruler.css";
import "./music-transport-title.css";
import "./music-theme.css";
import "./music-theme-switch.css";
import "./music-overview.css";
import "./android.css";
import "./music-now-playing.css";
import { version as bundledVersion } from "../package.json";
import { MusicOverviewUI } from "./music-overview-ui";
import { normalizeMusicArrayMode, type MusicArrayMode } from "./music-array-layout";
import { DocumentDecryption } from "./document-decryption";
import { ContentTransition, SurfaceTransition } from "./ui-transitions";
import { qualityMarkup, syncQualityUI } from "./quality-settings";
import type { ArchiveScene } from "./scene";
import { NativeArchiveScene } from "./native-archive-scene";
const nativeVulkan = new URLSearchParams(location.search).get("renderer") === "vulkan" || nativeAvailable();
const appVersion = new URLSearchParams(location.search).get("version") || bundledVersion;
const experimentalOpticsAvailable = nativeVulkan && new URLSearchParams(location.search).get("optics") === "rc";
async function createArchiveScene(container: HTMLElement) {
  if (nativeVulkan) return new NativeArchiveScene(container);
  const { ArchiveScene } = await import("./scene");
  return new ArchiveScene(container);
}
import {
  records,
  archiveColumns,
  columnFiles,
  fileLocation,
  setMusicAlbums,
  orderMusicAlbums,
  type MusicSortMode,
} from "./data";
import { fileAtCell, nearestOccurrence, wrap, type ArchiveNavigation } from "./archive-loop";
import {
  normalizeQuality,
  qualityPresets,
  type QualityPreset,
  type RenderQuality,
} from "./render-quality";
import type { MusicPlayerState } from "./music-player";
import { AndroidMusicPlayer, nativeAvailable, nativeCommand, nativeRequest } from "./android-native";
import { TerminalAudio } from "./audio";
import { androidDemoLibrary } from "./android-demo-library";
import { DEFAULT_LIGHTING_PRESET, normalizeRowLighting } from "./music-row-lighting";
import { normalizeSongTransition, type SongTransitionMode } from "./music-song-transition";
import { ModelViewer } from "./model-viewer";
import type {
  MusicAlbum,
  MusicGenre,
  MusicLibrary,
  GenreRules,
} from "./music-types";
import { demoAlbums, demoGenres } from "./demo-library";
import { escapeHtml as esc } from "./html";
import { albumTitleMarkup, setupMusicTitleLayout } from "./music-title";
import { setupMusicTextMotion } from "./music-text-motion";
import { setupTransportTitle } from "./music-transport-title";
import { setupMusicTicks } from "./music-ticks";
import { setupMusicRuler } from "./music-ruler";
import { MusicPresentation, type AlbumSelection } from "./music-presentation";
import { MusicTrackFocus } from "./music-track-focus";
import { MusicBoot } from "./music-boot";
import { MusicFrameTiming } from "./music-frame-timing";
import { searchMusicLibrary } from "./music-search";
import { viewportLayout } from "./viewport-layout";
import { setupLightingLab } from "./music-lighting-lab";
import type { LightingLabController, LightingLabSettings } from "./music-lighting-lab";
import { setupMotionLab } from "./music-motion-lab";
import { getMusicMotionSpeed, normalizeMusicMotionSpeed, onMusicMotionSpeedChange, setMusicMotionSpeed } from "./music-motion-settings";
import { mountMusicWheelNavigation } from "./music-wheel-navigation";

// A repeatable visual study that uses only the three bundled sample covers.
const lightingDemo = false;
const lightingLab = false;
let lightingControls: LightingLabController | undefined;
let motionControls: ReturnType<typeof setupMotionLab> | undefined;

type Theme = "day" | "night";
type Panel = "library" | "search" | "settings" | null;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const svg = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const icons = {
  play: svg('<path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none"/>'),
  pause: svg('<path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" stroke="none"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="1"/>'),
  search: svg(
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  ),
  settings: svg(
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="var(--surface)"/><circle cx="15" cy="17" r="2.5" fill="var(--surface)"/>',
  ),
  previous: svg('<path d="M5 5v14M19 5 8 12l11 7Z" fill="currentColor"/>'),
  next: svg('<path d="M19 5v14M5 5l11 7-11 7Z" fill="currentColor"/>'),
  speaker: svg('<path d="M4 9h4l5-4v14l-5-4H4Z"/><path d="M17 8a6 6 0 0 1 0 8M20 5a10 10 0 0 1 0 14"/>'),
  folder: svg('<path d="M3 7V5h6l2 2h10v13H3Z"/>'),
};
const read = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};
const preferences = {
  ...{
    theme: "day" as Theme,
    sortMode: "genre" as MusicSortMode,
    arrayMode: "filled" as MusicArrayMode,
    rememberColumnPosition: true,
    audioBackend: "browser" as "browser" | "coreaudio",
    outputDeviceId: "default",
    quality: "balanced" as QualityPreset,
    reduced: false,
    volume: 0.65,
    // Leave unset until legacy preferences have been read; a default here
    // would otherwise take precedence over the user's old fade-off choice.
    songTransition: undefined as SongTransitionMode | undefined,
    bgm: false,
    bgmVolume: 0.18,
    sound: false,
    soundVolume: 0.22,
    renderQuality: undefined as RenderQuality | undefined,
    developerMode: false,
    motionDebug: false,
    motionSpeed: 1,
    idleMotion: false,
    focusDepth: true,
    experimentalOptics: false,
    lighting: undefined as Partial<LightingLabSettings> | undefined,
  },
  ...read<
    Partial<{
      theme: Theme;
      sortMode: MusicSortMode;
      arrayMode: MusicArrayMode;
      rememberColumnPosition: boolean;
      audioBackend: "browser" | "coreaudio";
      outputDeviceId: string;
      quality: QualityPreset;
      reduced: boolean;
      volume: number;
      songTransition: SongTransitionMode;
      songFade: boolean;
      bgm: boolean;
      bgmVolume: number;
      sound: boolean;
      soundVolume: number;
      renderQuality: RenderQuality;
      developerMode: boolean;
      motionDebug: boolean;
      motionSpeed: number;
      idleMotion: boolean;
      focusDepth: boolean;
      experimentalOptics: boolean;
      lighting: Partial<LightingLabSettings>;
    }>
  >("rhinedroid-preferences", read("rhine-music-preferences", {})),
};
// Migrate only the old default; preserve explicit custom quality settings.
if (!read("rhine-render-v2", false)) {
  if (preferences.quality === "performance") {
    preferences.quality = "balanced";
    if (!preferences.renderQuality || (preferences.renderQuality.scale === 80 && preferences.renderQuality.pixelRatio === 1))
      preferences.renderQuality = { ...qualityPresets.balanced };
  }
  save("rhine-render-v2", true);
}
preferences.volume = typeof preferences.volume === "number" && Number.isFinite(preferences.volume) ? Math.min(1, Math.max(0, preferences.volume)) : 0.65;

preferences.songTransition = normalizeSongTransition(preferences.songTransition, preferences.songFade);
delete preferences.songFade;
let renderQuality = normalizeQuality(
  preferences.renderQuality || qualityPresets[preferences.quality],
);
if (!["day", "night"].includes(preferences.theme)) {
  preferences.theme = "day";
  save("rhinedroid-preferences", preferences);
}
if (!Object.hasOwn(qualityPresets, preferences.quality))
  preferences.quality = "original";
if (!["genre", "artist", "album"].includes(preferences.sortMode))
  preferences.sortMode = "genre";
preferences.developerMode = false;
preferences.motionDebug = false;
preferences.arrayMode = normalizeMusicArrayMode(preferences.arrayMode);
preferences.rememberColumnPosition = preferences.rememberColumnPosition !== false;
preferences.audioBackend = "browser";
if (typeof preferences.outputDeviceId !== "string") preferences.outputDeviceId = "default";
preferences.motionSpeed = normalizeMusicMotionSpeed(preferences.motionSpeed);
setMusicMotionSpeed(preferences.motionSpeed);
const syncMotionScale = () => document.documentElement.style.setProperty("--music-motion-scale", String(1 / getMusicMotionSpeed()));
syncMotionScale();
onMusicMotionSpeedChange(syncMotionScale);
const sortLabels: Record<MusicSortMode, { name: string; column: string; code: string }> = {
  genre: { name: "按流派", column: "流派", code: "GENRE" },
  artist: { name: "按歌手名字", column: "歌手", code: "ARTIST" },
  album: { name: "按专辑名字", column: "分组", code: "ALBUMS" },
};
const sortLabel = sortLabels[preferences.sortMode];
let nativeLibraryPending = false;
let libraryReceived = false,
  scanSubmitting = false;

let library: MusicLibrary = {
  version: 1,
  albums: [],
  genres: [],
  roots: [],
  scan: { running: false },
  onlineEnabled: false,
};
let albums: MusicAlbum[] = [],
  genres: MusicGenre[] = [],
  demo = false,
  selected = 0;
let mode: "archive" | "detail" = "archive",
  activeTab: "tracks" | "about" = "tracks",
  panel: Panel = null;
let scene: ArchiveScene | NativeArchiveScene | undefined,
  ready = false,
  apiAvailable = true,
  refreshing = false;
let introductionsStarting = false,
  libraryStateVersion = 0,
  introductionRequestError = "";
let creditsStarting = false,
  creditsRequestError = "",
  creditsRequestAlbumId: string | undefined;
let viewer: ModelViewer | undefined;
let boot: MusicBoot | undefined;
let overview = false;
let overviewRevealPending = false;
const effects = new TerminalAudio();
effects.configure({sound:preferences.sound,music:false,soundVolume:preferences.soundVolume,musicVolume:0});
let toastTimer: ReturnType<typeof setTimeout>,
  pollTimer: ReturnType<typeof setTimeout> | undefined;
let columnMemory = new Map<string, string>();
let playerState: MusicPlayerState;
let outputBusy = false;
let audioOutputsChecked = false;
let outputStatus = "正在检查本机音频输出…";
const player = new AndroidMusicPlayer({
  volume: preferences.volume,
  songTransitionMode: preferences.songTransition,
  bgmEnabled: preferences.bgm,
  bgmVolume: preferences.bgmVolume,
});
const themeNames: Record<Theme, string> = {
  day: "暖昼",
  night: "深夜",
};
const stage = $("#stage");
stage.className = "music-app";
stage.dataset.mode = "archive";
stage.dataset.theme = preferences.theme;
stage.dataset.android = "true";
stage.innerHTML = `
  <div id="three-scene" class="three-scene"></div>
  <div class="music-vignette" aria-hidden="true"></div>
  <header class="music-header">
    <div class="music-identity"><a class="music-brand" href="/index.html" aria-label="RhineDroid 音乐库"><strong>RhineDroid</strong><span>MUSIC ARCHIVE <i>／</i> LOCAL MUSIC PLAYER</span></a></div>
    <nav class="music-topnav" aria-label="音乐终端导航">
      <button data-action="library" aria-label="音乐库">${icons.folder}<span>音乐库</span></button>
      <button data-action="search" aria-label="搜索">${icons.search}<span>搜索</span></button>
      <div class="theme-switch" aria-label="主题">${(["day", "night"] as Theme[]).map((t) => `<button data-theme="${t}" aria-label="${themeNames[t]}主题" aria-pressed="${preferences.theme === t}"><i class="theme-dot ${t}"></i><span>${themeNames[t]}</span></button>`).join("")}</div>
      <button data-action="orientation" aria-label="切换横竖屏">↻</button><button data-action="settings" class="icon-button" aria-label="播放与画质设置">${icons.settings}</button>
      <div class="minimal-transport" role="group" aria-label="音乐播放"><button type="button" data-action="toggle-now-playing" aria-expanded="false" aria-controls="now-playing" id="transport-track" class="transport-track" aria-label="展开当前播放" aria-hidden="true" disabled><span id="transport-track-label"></span></button><button data-action="play-pause" id="play-pause" aria-label="播放" aria-pressed="false"><span class="transport-glyph transport-play" aria-hidden="true">${icons.play}</span><span class="transport-glyph transport-pause" aria-hidden="true">${icons.pause}</span></button><button data-action="stop" id="stop-playback" aria-label="停止">${icons.stop}</button></div>
    </nav>
  </header>
  <div id="library-status" class="library-status"><i></i><span>正在读取本地音乐索引</span></div>
  <button type="button" class="music-view-toggle" disabled data-action="overview" aria-pressed="false" aria-label="切换缩略图模式">${svg('<rect x="3" y="3" width="6" height="7"/><rect x="15" y="3" width="6" height="7"/><rect x="3" y="14" width="6" height="7"/><rect x="15" y="14" width="6" height="7"/>')}<span>缩略图模式</span><kbd>V</kbd></button>
  <section class="music-overview" id="music-overview" aria-label="音乐库缩略图总览" hidden>
    <div class="overview-heading"><small>COLLECTION / OVERVIEW</small><h2>${sortLabel.name}浏览收藏</h2><p>点击列名展开入口 · 点击进入回到标准视图</p></div>
    <div class="overview-columns" id="overview-columns"></div>
    <button type="button" class="overview-return" data-action="overview-return" aria-label="返回标准视图">${svg('<path d="M15 5l-7 7 7 7"/>')}<span>返回近景</span><kbd>V</kbd></button>
    <nav class="overview-controls" aria-label="总览列导航"><button data-action="genre-prev" aria-label="总览上一列">←</button><span>← → 切换${sortLabel.column}</span><button data-action="genre-next" aria-label="总览下一列">→</button></nav>
  </section>
  <section id="music-browse" class="music-browse" aria-label="专辑浏览">
    <div class="music-browse-veil" aria-hidden="true"></div>
    <div class="album-callout"><p class="music-eyebrow">MUSIC ARCHIVE <span>／</span> <span id="selection-genre"></span></p>
      <div class="selection-rule"><span id="selection-code">ALBUM <span id="selection-code-number">001</span></span><span id="selection-format"></span></div>
      <h1 id="selection-title"></h1><p id="selection-artist" class="selection-artist"></p>
      <div class="selection-meta" id="selection-meta"></div>
      <button class="open-album" data-action="open">打开专辑 <span>↗</span></button>
    </div>
    <div class="music-navigation">
      <div class="music-counter"><span class="music-eyebrow">ALBUM / SELECT</span><div><b id="selection-number">01</b><span>/ <i id="selection-total">00</i></span></div></div>
      <div class="album-stepper"><button data-action="prev" aria-label="上一个专辑">↑</button><div id="album-ticks"></div><button data-action="next" aria-label="下一个专辑">↓</button></div>
      <div class="genre-stepper"><button data-action="genre-prev" aria-label="上一个${sortLabel.column}">←</button><div><small id="genre-position">${sortLabel.code} <span id="genre-index">01</span> / <span id="genre-total">00</span></small><button data-action="genres" id="genre-name"></button></div><button data-action="genre-next" aria-label="下一个${sortLabel.column}">→</button></div>
    </div>
    <div class="music-keyhint">← → ${sortLabel.column} <span>／</span> ↑ ↓ 或滚轮切专辑 <span>／</span> ENTER 打开专辑</div>
  </section>
  <section id="music-detail" class="music-detail" aria-label="专辑详情" hidden>
    <button class="music-back" data-action="back">← 返回专辑架 <kbd>ESC</kbd></button>
    <div class="card-caption"><span id="detail-card-id"></span><small>拖动卡片，查看完整封面</small></div>
    <article id="album-detail-content" tabindex="-1"></article>
  </section>
  <div id="music-empty" class="music-empty" hidden><small>YOUR PRIVATE COLLECTION</small><h1>让音乐进入这座档案馆。</h1><p>授权读取设备音乐，专辑封面会出现在每一张卡片上。</p><button data-action="scan">扫描设备音乐 ↗</button><button data-action="library" class="subtle">查看音乐库</button></div>
  <div class="music-bottomline"><span>LOCAL COLLECTION <i>·</i> <span id="library-count">0 ALBUMS</span></span><span id="runtime-info">THREE.JS / LOCAL / V${esc(appVersion)}</span></div>
  <section id="now-playing" class="now-playing" aria-label="当前播放" hidden>
    <div class="now-glass" aria-hidden="true"><img id="now-backdrop" alt="" hidden></div>
    <div class="now-record">
      <button id="now-cover" type="button" data-action="locate-playing" aria-label="查看当前专辑"></button>
      <button class="now-metadata" data-action="toggle-now-playing" aria-label="收起当前播放" aria-describedby="now-title now-artist"><strong id="now-title"></strong><span id="now-artist"></span><span id="now-album"></span></button>
    </div>
    <div class="now-progress"><span id="now-elapsed">0:00</span><input id="now-seek" type="range" min="0" max="1" step="0.1" value="0" aria-label="播放进度"><span id="now-duration">0:00</span></div>
    <div class="now-controls" role="group" aria-label="歌曲控制">
      <button data-action="previous-track" aria-label="上一首">${icons.previous}</button>
      <button data-action="play-pause" id="now-toggle" aria-label="播放"><span class="now-play">${icons.play}</span><span class="now-pause">${icons.pause}</span></button>
      <button data-action="next-track" aria-label="下一首">${icons.next}</button>
    </div>
    <div class="now-footer"><label class="now-volume">${icons.speaker}<input id="now-volume" type="range" min="0" max="1" step="0.01" value="0.65" aria-label="音量"><output id="now-volume-value">65%</output></label><button data-action="stop" aria-label="停止播放">${icons.stop}</button></div>
    <p id="now-error" role="status"></p>
  </section>
  <div id="music-panel-root"></div><div id="music-toast" role="status" aria-live="polite"></div>
  <div id="music-loading"><span class="loading-orbit"></span><strong>OPENING THE ARCHIVE</strong><small>正在载入三维专辑架</small></div>
`;
const titleMotion = setupMusicTitleLayout(stage);
const textMotion = setupMusicTextMotion(stage);
// Keep the previous navigation available while the ruler version is on trial.
const tickMotion = new URLSearchParams(location.search).get("nav") === "previous"
  ? setupMusicTicks($("#album-ticks"))
  : setupMusicRuler($("#album-ticks"));
let selectionInitialized = false;
const selectionMotionEnabled = () =>
  ready &&
  !boot?.active &&
  mode === "archive" &&
  !$("#music-browse").hidden &&
  !preferences.reduced;
function syncSelectionMotion() {
  // Build static reels during the hidden camera movement, before the text fades in.
  const enabled = selectionMotionEnabled() ||
    (mode === "archive" && !!albums.length && !preferences.reduced);
  textMotion.setEnabled(enabled);
  if (!enabled) titleMotion.finish();
  else {
    const album = currentAlbum();
    if (album) titleMotion.update(album.title, true);
  }
}

function notify(message: string) {
  $("#music-toast").textContent = message;
  $("#music-toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => $("#music-toast").classList.remove("visible"),
    5500,
  );
}
function time(value: number) {
  const n = Math.max(0, Math.floor(value || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}
function genreName(id: string) {
  return genres.find((g) => g.id === id)?.name || "未分类";
}
function currentAlbum() {
  return albums.find((a) => a.id === records[selected]?.id);
}
function formatList(a: MusicAlbum) {
  return (
    [
      ...new Set(
        a.tracks.map((t) => (t.codec ? `${t.format} / ${t.codec}` : t.format)),
      ),
    ].join(" · ") || (demo ? "封面演示" : "未提供")
  );
}
function albumDuration(a: MusicAlbum) {
  return a.tracks.reduce((sum, t) => sum + t.duration, 0);
}
function valueRange(
  values: (number | undefined)[],
  format: (n: number) => string,
) {
  const n = [
    ...new Set(values.filter((v): v is number => !!v && Number.isFinite(v))),
  ].sort((a, b) => a - b);
  return n.length
    ? n.length === 1
      ? format(n[0])
      : `${format(n[0])}–${format(n[n.length - 1])}`
    : "未提供";
}
function cover(a: MusicAlbum, className = "") {
  return a.coverUrl
    ? `<img class="${className}" src="${esc(a.coverUrl)}" alt="${esc(a.title)}专辑封面" loading="lazy">`
    : `<span class="cover-placeholder">♪</span>`;
}
const documentDecryption = new DocumentDecryption(
  "h1, .detail-artist, .album-facts span, .track-name strong, .album-about p",
  0.35,
);
const tabTransition = new ContentTransition();
const detailTransition = new SurfaceTransition(
  $("#music-detail"),
  $("#album-detail-content"),
  360,
  240,
  "right",
);
const browseTransition = new SurfaceTransition(
  $("#music-browse"),
  undefined,
  // Keep the existing reveal timing, but fade each overlay in its own layer.
  // Fading the parent traps its text below the night vignette until opacity=1.
  720,
  140,
  "up",
  "cubic-bezier(0.45, 0, 0.25, 1)",
  [$(".music-browse-veil"), $(".album-callout"), $(".music-navigation"), $(".music-keyhint")],
);
const overviewUI = new MusicOverviewUI($("#music-overview"), $("#overview-columns"), () => {
  const target = overview ? $(".overview-return") : $('[data-action="overview"]');
  target.focus({ preventScroll: true });
});
let detailIdentity = "",
  pendingDetailFocus = false;
const trackFocus = new MusicTrackFocus();
let pendingTrackReveal: { albumId: string; trackId: string } | undefined;
function cancelTrackReveal() {
  pendingTrackReveal = undefined;
  trackFocus.cancel();
}
// The pane is interactive while its entrance is finishing. Cancel a queued
// reveal too, so a click/scroll in that interval is never pulled back later.
for (const event of ["wheel", "pointerdown", "touchstart", "keydown"] as const) {
  $("#album-detail-content").addEventListener(event, () => {
    if (pendingTrackReveal) cancelTrackReveal();
  }, { passive: true });
}
let libraryRebuilding = false;
type LibraryIntent = AlbumSelection & { openAfter: boolean } |
  { mode: "archive" | "detail" };
let libraryIntent: LibraryIntent | undefined;
const presentation = new MusicPresentation({
  presentationReady: () => scene?.musicPresentationReady ?? false,
  archiveReady: () => !!scene?.musicArchiveReady && scene.musicOverviewProgress < .02,
  archiveInteractive: () => scene?.musicArchiveInteractive ?? false,
  enterCamera: () => {
    scene?.setMode("detail");
    effects.setScene("detail");
    effects.play("open");
  },
  returnCamera: () => {
    scene?.setMode("archive");
    effects.setScene("archive");
    effects.play("back");
  },
  select: ({ index, navigation, route }) => commitSelection(index, navigation, false, route === "archive"),
  switchDetail: ({ index, navigation }) => commitSelection(index, navigation, true),
  mode: (next) => {
    if (next === "detail" && overview) setOverview(false, false);
    mode = next;
    stage.dataset.mode = next;
    syncSelectionMotion();
  },
  prepareMenu: () => {
    activeTab = "tracks";
    detailTransition.hide(true);
    renderDetail();
    const content = $("#album-detail-content");
    content.style.removeProperty("opacity");
    content.style.removeProperty("transform");
    $("#music-detail").inert = true;
    $("#music-detail").setAttribute("aria-hidden", "true");
  },
  showMenu: () => {
    const detail = $("#music-detail"), content = $("#album-detail-content");
    detailTransition.show(preferences.reduced);
    detail.inert = !!panel;
    detail.setAttribute("aria-hidden", "false");
    content.inert = false;
    content.scrollTop = 0;
    documentDecryption.reset(content, preferences.reduced);
    pendingDetailFocus = true;
  },
  hideMenu: (done) => {
    trackFocus.cancel();
    pendingDetailFocus = false;
    tabTransition.cancel();
    $("#music-detail").inert = true;
    $("#music-detail").setAttribute("aria-hidden", "true");
    detailTransition.hide(preferences.reduced, done);
  },
  hideBrowse: (done) => {
    $("#music-browse").inert = true;
    $("#music-browse").setAttribute("aria-hidden", "true");
    browseTransition.hide(preferences.reduced, done);
  },
  showBrowse: showBrowseSurface,
});
boot = new MusicBoot(stage, {
  reduced: () => preferences.reduced,
  onStart: () => {
    setOverview(false, false);
    cancelTrackReveal();
    presentation.reset();
    syncAlbumNavigation();
    detailTransition.hide(true);
    browseTransition.hide(true);
    scene?.setMode("hidden");
    syncSelectionMotion();
  },
  onComplete: (reason) => {
    const now = performance.now() / 1000;
    if (reason === "skip") scene?.showMusicArchiveImmediately(now);
    else scene?.finishMusicIntro(now);
    effects.setScene("archive");
    showBrowseSurface();
  },
});
function showBrowseSurface() {
  syncAlbumNavigation();
  if (!albums.length || boot?.active) return;
  if (overview) { $("#music-browse").inert = true; return; }
  browseTransition.show(preferences.reduced);
  $("#music-browse").inert = !!panel;
  $("#music-browse").setAttribute("aria-hidden", "false");
  syncSelectionMotion();
  if (!panel) $("[data-action=open]").focus({ preventScroll: true });
}
function setOverview(active: boolean, reveal = true) {
  if (active && (!ready || !albums.length || boot?.active || panel || mode !== "archive")) return;
  overview = active;
  overviewRevealPending = !active && reveal;
  scene?.setMusicOverview(active);
  stage.dataset.overview = String(active);
  const toggle = $<HTMLButtonElement>('[data-action="overview"]');
  toggle.setAttribute("aria-pressed", String(active));
  for (const item of stage.querySelectorAll<HTMLElement>(".music-topnav > :not(.minimal-transport)")) item.inert = active;
  toggle.inert = active || !!panel;
  overviewUI.setActive(active, preferences.reduced);
  $("#music-overview").inert = !active || !!panel;
  $("#music-browse").inert = active || !!panel;
  $("#music-browse").setAttribute("aria-hidden", String(active));
  if (active) {
    browseTransition.hide(preferences.reduced);
    // Focus the return control after its visible entrance, never a hidden toggle.
  }
}
function updateOverview() {
  if (!scene || (!overview && $("#music-overview").hidden)) return;
  overviewUI.update(scene.getOverviewColumns(), stage.clientWidth, stage.clientHeight,
    scene.musicOverviewProgress, preferences.reduced, sortLabel.column);
}
function savePrefs() {
  save("rhinedroid-preferences", preferences);
}
function performanceReport() {
  const host = $("#three-scene");
  const composition = [];
  for (let element: HTMLElement | null = host; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    composition.push({ element: element.id || element.tagName.toLowerCase(),
      backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, opacity: style.opacity });
  }
  return {
    version: `${appVersion}-startup`, browser: navigator.userAgent,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    hidden: document.hidden, phase: stage.dataset.musicBoot,
    quality: JSON.parse(host.dataset.renderQuality || "null"),
    preparation: JSON.parse(host.dataset.startupPreparation || "null"),
    frame: { scope: "web-ui", ...frameTiming.snapshot() },
    render: scene?.getStats() ?? null,
    composition,
    serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
  };
}
async function copyPerformanceReport() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(performanceReport(), null, 2));
    notify("性能诊断已复制，不包含音乐文件路径、曲名或封面。");
  } catch { notify("浏览器未允许复制，请检查剪贴板权限后重试。"); }
}
async function exportLog() {
  try {
    await nativeCommand("export-log", { diagnostics: performanceReport() });
    notify("正在准备日志，请在系统文件选择器中保存 ZIP。");
  } catch (error) { notify(error instanceof Error ? error.message : "日志导出失败，请重试。"); }
}
function setTheme(theme: Theme) {
  if (theme !== "day" && theme !== "night") theme = "day";
  if (theme === preferences.theme) return;
  preferences.theme = theme;
  stage.dataset.theme = theme;
  scene?.setTheme(theme, !preferences.reduced);
  viewer?.setTheme(theme);
  document
    .querySelectorAll<HTMLButtonElement>("button[data-theme]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.theme === theme)),
    );
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "night" ? "#08121f" : "#e8e5e1");
  savePrefs();
}
let previousLayout = "";
let previousBoxes: DOMRect[] = [];
let previousWidth = 0, previousHeight = 0, fitFrame = 0;
const layoutAnimations: Animation[] = [];
function fit() {
  const width = stage.clientWidth, height = stage.clientHeight;
  if (width === previousWidth && height === previousHeight) return;
  const layout = viewportLayout(width, height, matchMedia("(pointer: coarse)").matches).kind;
  const elements = [$(".album-callout"), $("#album-detail-content"), $(".music-navigation"), $("#now-playing")];
  const changed = previousLayout && previousLayout !== layout;
  layoutAnimations.splice(0).forEach(animation => animation.cancel());
  stage.dataset.layout = layout;
  const boxes = elements.map(element => element.getBoundingClientRect());
  if (changed && !preferences.reduced && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    elements.forEach((element, i) => {
      if (element.hidden || (element.id === "now-playing" && element.dataset.transition !== "open")) return;
      const before = previousBoxes[i], after = boxes[i];
      if (before?.width && after.width) {
        // Keep edge-anchored controls inside the new viewport throughout rotation.
        const x = Math.max(-after.left, Math.min(width - after.right, Math.max(-48, Math.min(48, before.left - after.left))));
        const y = Math.max(-after.top, Math.min(height - after.bottom, Math.max(-48, Math.min(48, before.top - after.top))));
        layoutAnimations.push(element.animate([
          { translate: `${x}px ${y}px`, opacity: 0.6 },
          { translate: "0px 0px", opacity: 1 },
        ], { duration: 240, easing: "cubic-bezier(.22,1,.36,1)" }));
      }
    });
  }
  previousLayout = layout; previousBoxes = boxes;
  previousWidth = width; previousHeight = height;
  scene?.resize(); viewer?.resize();
  if (mode === "detail") { syncTabIndicator(false); documentDecryption.refresh(); }
}
function scheduleFit() {
  if (!fitFrame) fitFrame = requestAnimationFrame(() => { fitFrame = 0; fit(); });
}
window.addEventListener("resize", scheduleFit);
new ResizeObserver(scheduleFit).observe(stage);

async function request<T>(route: string, body?: unknown): Promise<T> {
  const result = await nativeRequest<T>("library-api", {route, ...(body === undefined ? {} : {body})});
  if(route.startsWith("/api/library/") || route === "/api/album/genre") {
    const response = await fetch("/native/library", {cache:"no-store"});
    if(!response.ok) throw new Error("曲库状态暂时无法读取");
    return response.json() as Promise<T>;
  }
  return result;
}
async function loadLibrary(force = false) {
  if (frameDisposed) return;
  if (!libraryReceived || force) {
    if (nativeAvailable()) {
      const response = await fetch("/native/library", { cache: "no-store" });
      if (!response.ok) throw new Error("读取音乐库失败，请重新扫描。");
      const next: MusicLibrary = await response.json();
      if (!frameDisposed) { player.setTracks(next.albums.flatMap(album => album.tracks)); await receiveLibrary(next, true); }
    } else await receiveLibrary(androidDemoLibrary, true);
  }
}
async function receiveLibrary(next: MusicLibrary, force = false) {
  const previousScan = library.scan;
  const scanCompleted = libraryReceived && !next.scan.running && !next.scan.error &&
    !!next.scan.finishedAt && next.scan.finishedAt !== previousScan.finishedAt;
  const scanFailed = libraryReceived && previousScan.running && !next.scan.running && !!next.scan.error;
  libraryReceived = true;
  const previousIntroductionRun = library.introductions;
  const previousCreditsRun = library.credits;
  const changed =
    JSON.stringify(next.albums) !== JSON.stringify(library.albums) ||
    JSON.stringify(next.genres) !== JSON.stringify(library.genres);
  const creditsOnly = changed && !force && !demo &&
    JSON.stringify(next.genres) === JSON.stringify(library.genres) &&
    JSON.stringify(next.albums.map(albumWithoutCredits)) === JSON.stringify(library.albums.map(albumWithoutCredits));
  const previousCurrentCredits = JSON.stringify([currentAlbum()?.producers, currentAlbum()?.creditsLookup]);
  library = next;
  if (library.introductions?.running) introductionRequestError = "";
  if (library.credits?.running) creditsRequestError = "";
  if (creditsOnly) {
    // Updating credits must not reset the selected column, scene, tracks or scroll.
    const byId = new Map(next.albums.map((album) => [album.id, album]));
    albums = albums.map((album) => byId.get(album.id) || album);
    for (const record of records) {
      const album = byId.get(record.id);
      if (album) record.album = album;
    }
    if (mode === "detail" && previousCurrentCredits !== JSON.stringify([currentAlbum()?.producers, currentAlbum()?.creditsLookup]))
      renderCurrentCredits();
  } else if (changed || force) await applyLibrary();
  updateStatus();
  if (panel === "library") updateScanStatus();
  updateIntroductionStatus();
  updateCreditsStatus();
  if (previousCreditsRun?.running && library.credits && !library.credits.running)
    notify(creditsRunSummary(library.credits));
  if (
    previousIntroductionRun?.running &&
    library.introductions &&
    !library.introductions.running
  ) {
    const result = library.introductions;
    notify(
      result.error ||
        `专辑介绍查询完成：更新 ${result.updated} 张，未找到可靠资料 ${result.notFound} 张，查询失败 ${result.failed} 张。`,
    );
  }
  if (scanFailed) notify(`音乐库扫描失败：${next.scan.error}`);
  if (scanCompleted) notify("音乐库扫描完成，专辑架已更新。");
}
function albumWithoutCredits(album: MusicAlbum) {
  const { producers: _producers, creditsLookup: _lookup, ...detail } = album;
  return detail;
}
async function applyLibrary() {
  const hadAlbums = albums.length > 0;
  const previousId = currentAlbum()?.id;
  const previousAlbum = currentAlbum();
  const previousDetail = JSON.stringify(currentAlbum());
  const visualKey = (items: MusicAlbum[], groups: MusicGenre[]) =>
    JSON.stringify([
      items.map((a) => [a.id, a.title, a.artist, a.genreId, a.coverUrl]),
      groups.map((g) => [g.id, g.name]),
    ]);
  const oldVisual = visualKey(albums, genres);
  if (library.albums.length) demo = false;
  albums = orderMusicAlbums(demo ? demoAlbums : library.albums, preferences.sortMode);
  if (!albums.length && overview) setOverview(false, false);
  genres = demo ? demoGenres : library.genres;
  setMusicAlbums(albums, genres, preferences.sortMode);
  selected = Math.max(
    0,
    records.findIndex((r) => r.id === previousId),
  );
  columnMemory = new Map(
    archiveColumns.map((name, lane) => [
      name,
      records[columnFiles(lane)[0]]?.id,
    ]),
  );
  if (scene && ready && oldVisual !== visualKey(albums, genres)) {
    const reopen = presentation.openingOrDetail;
    cancelTrackReveal();
    libraryRebuilding = true;
    libraryIntent = undefined;
    presentation.reset();
    detailTransition.hide(true);
    browseTransition.hide(true);
    try { await scene.refreshLibrary(selected); }
    finally { libraryRebuilding = false; }
    const intent = libraryIntent as LibraryIntent | undefined;
    libraryIntent = undefined;
    scene.setMode("archive");
    if (intent && "index" in intent)
      select(intent.index, intent.navigation, intent.openAfter, intent.route);
    else if ((intent ? intent.mode === "detail" : reopen) && albums.length)
      presentation.open();
    else showBrowseSurface();
  }
  if (!albums.length) {
    cancelTrackReveal();
    presentation.reset();
  }
  stage.dataset.mode = mode;
  $("#music-empty").hidden = albums.length > 0;
  // Ordinary index refreshes must not reveal a page while its peer is exiting.
  if (!ready || !hadAlbums || !albums.length) {
    if (albums.length && mode === "archive") browseTransition.show(true);
    else browseTransition.hide(true);
    // Detail is revealed exclusively by the camera completion gate.
    if (presentation.phase !== "detail") detailTransition.hide(true);
    $("#music-browse").inert = !albums.length || mode !== "archive" || !!panel;
    $("#music-detail").inert = !albums.length || mode !== "detail" || !!panel;
    $("#music-browse").setAttribute(
      "aria-hidden",
      String(!albums.length || mode !== "archive"),
    );
    $("#music-detail").setAttribute(
      "aria-hidden",
      String(!albums.length || mode !== "detail"),
    );
  }
  updateSelection();
  if (mode === "detail" && previousDetail !== JSON.stringify(currentAlbum())) {
    const album = currentAlbum();
    if (previousAlbum && album && previousAlbum.id === album.id &&
        JSON.stringify(albumWithoutCredits(previousAlbum)) === JSON.stringify(albumWithoutCredits(album)))
      renderCurrentCredits();
    else renderDetail();
  }
  updateStatus();
}
function updateStatus() {
  const n = library.albums.length,
    tracks = library.albums.reduce((sum, a) => sum + a.tracks.length, 0);
  $<HTMLButtonElement>('[data-action="overview"]').hidden = !albums.length;
  const label = nativeAvailable() ? `设备音乐 · ${tracks} 首` : "浏览器预览 · 静音演示";
  $("#library-status span").textContent = label;
  $("#library-status").hidden = !label;
  $("#library-status").classList.toggle(
    "working",
    !!library.scan.running ||
      !!library.enrich?.running ||
      !!library.introductions?.running ||
      !!library.credits?.running,
  );
  $("#library-count").textContent = demo
    ? "DEMONSTRATION"
    : `${n} ALBUMS / ${tracks} TRACKS`;
}
function updateSelection(navigation?: ArchiveNavigation) {
  syncAlbumNavigation();
  const a = currentAlbum();
  if (!a) {
    selectionInitialized = false;
    textMotion.finish();
    titleMotion.finish();
    return;
  }
  const location = fileLocation(selected),
    files = columnFiles(location.lane),
    idx = files.indexOf(selected);
  const animated = selectionInitialized && selectionMotionEnabled();
  selectionInitialized = true;
  textMotion.update(
    {
      number: idx + 1,
      total: files.length,
      genresTotal: archiveColumns.length,
      code: selected + 1,
      genreIndex: location.lane + 1,
      genre: archiveColumns[location.lane],
      genreName: archiveColumns[location.lane],
      format: demo
        ? "DEMO"
        : [...new Set(a.tracks.map((t) => t.format))].join(" / "),
      artist: a.artist,
      meta: [
        a.year ? String(a.year) : "年份未提供",
        demo ? "演示封面" : `${a.tracks.length} 首曲目`,
        a.tracks.length ? time(albumDuration(a)) : "",
      ]
        .filter(Boolean)
        .join("  /  "),
    },
    animated,
    navigation,
  );
  titleMotion.update(a.title, animated);
  $("#selection-title").title = a.title;
  tickMotion.update(
    files.map((index) => ({ index, id: records[index].id, title: records[index].title })),
    selected,
    preferences.reduced,
    navigation,
    preferences.arrayMode === "filled",
  );
  $("#detail-card-id").textContent =
    `ALBUM / ${String(selected + 1).padStart(3, "0")}`;
  // Hidden archive content can prepare its static reels before the reveal.
  if (!animated) syncSelectionMotion();
}
function commitSelection(index: number, navigation?: ArchiveNavigation, keepDetail = false, jump = false) {
  selected = wrap(index, records.length);
  if (preferences.rememberColumnPosition) columnMemory.set(
    archiveColumns[fileLocation(selected).lane],
    records[selected].id,
  );
  if (jump && scene instanceof NativeArchiveScene) scene.select(selected, navigation, true);
  else if (keepDetail) scene?.switchMusicAlbum(selected, navigation);
  else scene?.select(selected, navigation);
  updateSelection(navigation);
  effects.play(
    navigation && "axis" in navigation && navigation.axis === "lane"
      ? "column"
      : "tick",
  );
}
function select(index: number, navigation?: ArchiveNavigation, openAfter = presentation.openingOrDetail, route?: AlbumSelection["route"]) {
  if (!records.length || !ready || boot?.active || index < 0) return;
  if (route !== "archive") cancelTrackReveal();
  const pending = libraryRebuilding && libraryIntent && "index" in libraryIntent
    ? libraryIntent : presentation.pendingSelection;
  const previous = pending?.navigation;
  if (pending && navigation && !("cell" in navigation)) {
    // Coalesced key presses still reach the matching physical loop cell.
    if (previous && "axis" in previous && previous.axis === navigation.axis) {
      navigation = { ...navigation, direction: previous.direction + navigation.direction };
    } else if (navigation.axis === "lane" && navigation.row !== undefined) {
      if (previous && "cell" in previous) {
        navigation = { ...previous, cell: {
          lane: previous.cell.lane + navigation.direction, row: navigation.row,
        } };
      } else {
        // A pending search or row change may target a different logical column.
        // Compute its relative occurrence before adding the new arrow direction;
        // this offset is invariant across physical loop periods.
        const committedLane = fileLocation(selected).lane;
        const pendingLane = nearestOccurrence(fileLocation(pending.index).lane,
          committedLane, archiveColumns.length);
        navigation = { ...navigation, direction: pendingLane - committedLane + navigation.direction };
      }
    } else if (!preferences.rememberColumnPosition && navigation.axis === "row" && previous) {
      if ("cell" in previous) {
        navigation = { ...previous, cell: {
          lane: previous.cell.lane, row: previous.cell.row + navigation.direction,
        } };
      } else if (previous.axis === "lane" && previous.row !== undefined) {
        // A vertical key inside a queued column change must keep that column's
        // accumulated displacement as well as the requested neighboring album.
        navigation = { ...previous, row: previous.row + navigation.direction };
      } else navigation = undefined;
    } else navigation = undefined;
  }
  if (libraryRebuilding) {
    libraryIntent = { index: wrap(index, records.length), navigation, openAfter, route };
    syncAlbumNavigation();
    return;
  }
  presentation.select({ index: wrap(index, records.length), navigation, route }, openAfter);
  syncAlbumNavigation();
}
/** Playback can reuse its open album; other targets take the archive route. */
function revealAlbum(albumId: string, trackId?: string, options: { reuseOpenAlbum?: boolean } = {}) {
  closePanel(() => {
    cancelTrackReveal();
    if (!ready || boot?.active) return;
    const index = records.findIndex((record) => record.id === albumId);
    const album = albums.find((item) => item.id === albumId);
    if (index < 0 || !album || (trackId && !album.tracks.some((track) => track.id === trackId))) {
      notify("这张专辑或歌曲已不在当前音乐库中，请刷新音乐库后重试。");
      return;
    }
    if (options.reuseOpenAlbum && trackId && !libraryRebuilding &&
      currentAlbum()?.id === albumId && presentation.openingOrDetail &&
      !presentation.pendingSelection &&
      ["detail", "opening", "switching"].includes(presentation.phase)) {
      // Preserve the camera and current scroll position. If the album is still
      // entering, the usual detail gate below will wait before revealing it.
      setTab("tracks");
      pendingTrackReveal = { albumId, trackId };
      return;
    }
    if (trackId) pendingTrackReveal = { albumId, trackId };
    if (overview) setOverview(false, false);
    select(index, undefined, true, "archive");
  });
}
function navigationSelection() {
  if (libraryRebuilding && libraryIntent && "index" in libraryIntent) return libraryIntent.index;
  return presentation.pendingSelection?.index ?? selected;
}
/** Pending detail/return requests already define the next input boundary. */
function syncAlbumNavigation() {
  const cursor = navigationSelection();
  const files = records.length ? columnFiles(fileLocation(cursor).lane) : [];
  const ordinal = files.indexOf(cursor);
  const bounded = preferences.arrayMode === "realistic";
  for (const button of stage.querySelectorAll<HTMLButtonElement>('[data-action="prev"], [data-action="next"]')) {
    button.disabled = !files.length || (bounded && (button.dataset.action === "prev"
      ? ordinal <= 0 : ordinal >= files.length - 1));
  }
}
function stepAlbum(direction: number) {
  if (!records.length) return;
  const cursor = navigationSelection();
  const files = columnFiles(fileLocation(cursor).lane);
  if (files.length < 2) return;
  const ordinal = files.indexOf(cursor);
  const target = preferences.arrayMode === "realistic"
    ? Math.max(0, Math.min(files.length - 1, ordinal + direction))
    : wrap(ordinal + direction, files.length);
  const delta = preferences.arrayMode === "realistic" ? target - ordinal : direction;
  // A boundary input must not restart a detail handoff or cancel track focus.
  if (!delta) return;
  select(files[target], { axis: "row", direction: delta });
}
/** Column arrows and overview entry obey one browsing-position preference. */
function resolveColumnSelection(lane: number): { index: number; row?: number } {
  const files = columnFiles(lane);
  if (!files.length) return { index: -1 };
  if (preferences.rememberColumnPosition) {
    const remembered = columnMemory.get(archiveColumns[lane]);
    const index = files.find((index) => records[index]?.id === remembered);
    return { index: index ?? files[0] };
  }
  // The rendered rail can still be between targets after rapid input. Sample
  // its actual depth, then preserve that physical occurrence in filled arrays.
  const depth = Math.round(scene?.musicBrowseRowForColumn(lane) ??
    scene?.musicBrowseRow ?? fileLocation(navigationSelection()).row);
  const row = preferences.arrayMode === "realistic"
    ? Math.max(12, Math.min(11 + files.length, depth)) : depth;
  return { index: fileAtCell({ lane, row }), row };
}
function stepGenre(direction: number) {
  overviewUI.collapse();
  if (!records.length || archiveColumns.length < 2) return;
  const lane = wrap(
    fileLocation(navigationSelection()).lane + direction,
    archiveColumns.length,
  );
  const target = resolveColumnSelection(lane);
  select(target.index, {
    axis: "lane",
    direction,
    row: target.row,
  });
}
function setMode(next: "archive" | "detail") {
  if (boot?.active) return;
  if (next === "archive") cancelTrackReveal();
  if (libraryRebuilding) { libraryIntent = { mode: next }; syncAlbumNavigation(); return; }
  if (next === "detail") {
    if (overview) setOverview(false, false);
    if (currentAlbum()) presentation.open();
  } else presentation.back();
  syncAlbumNavigation();
}
function syncTabIndicator(animate = true) {
  const button = document.querySelector<HTMLElement>(`#tab-${activeTab}`);
  const indicator = document.querySelector<HTMLElement>(".music-tab-indicator");
  if (!button || !indicator) return;
  indicator.style.transition = animate && !preferences.reduced ? "" : "none";
  indicator.style.transform = `translateX(${button.offsetLeft}px) scaleX(${button.offsetWidth})`;
}
function setTab(tab: "tracks" | "about") {
  if (activeTab === tab) return;
  cancelTrackReveal();
  activeTab = tab;
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  syncTabIndicator();
  const a = currentAlbum();
  if (!a) return;
  const content = $("#album-tab-content");
  content.innerHTML =
    tab === "tracks" ? trackList(a, a.discCount || 1) : albumAbout(a);
  content.setAttribute("aria-labelledby", `tab-${tab}`);
  documentDecryption.refresh();
  tabTransition.reveal(content, preferences.reduced);
  updatePlayingRows();
  effects.play("ui-tick");
}
function renderDetail() {
  const a = currentAlbum();
  if (!a) return;
  trackFocus.cancel();
  const discs =
    a.discCount || Math.max(1, ...a.tracks.map((t) => t.discNumber || 1));
  const bits =
    a.tracks.length && a.tracks.every((t) => t.lossless === false)
      ? "有损编码"
      : valueRange(
          a.tracks.map((t) => t.bitsPerSample),
          (n) => `${n} bit`,
        );
  const rate = valueRange(
    a.tracks.map((t) => t.sampleRate),
    (n) => `${Number((n / 1000).toFixed(1))} kHz`,
  );
  const bitrate = valueRange(
    a.tracks.map((t) => t.bitrate),
    (n) => `${Math.round(n / 1000)} kbps`,
  );
  const fields = [
    ["RELEASE / 发行年份", a.year || "未提供"],
    ["ARTIST / 歌手", a.artist],
    ["GENRE / 流派", genreName(a.genreId)],
    ["VOLUMES / 内含 CD", demo ? "—" : `${discs} CD · ${a.tracks.length} 首`],
    ["FORMAT / 文件格式", formatList(a)],
    ["RESOLUTION / 位深与采样率", `${bits} / ${rate}`],
    ["BITRATE / 码率", bitrate],
    ["DURATION / 总时长", time(albumDuration(a))],
  ];
  const article = $("#album-detail-content"),
    sameAlbum = detailIdentity === a.id,
    scroll = sameAlbum ? article.scrollTop : 0;
  detailIdentity = a.id;
  article.innerHTML = `<div class="detail-overline"><span>ALBUM ${String(selected + 1).padStart(3, "0")}</span><div class="detail-album-navigation" role="group" aria-label="切换专辑"><button data-action="prev" aria-label="上一张专辑">↑ 上一张</button><button data-action="next" aria-label="下一张专辑">下一张 ↓</button></div></div>
    <h1 title="${esc(a.title)}">${albumTitleMarkup(a.title)}</h1><p class="detail-artist">${esc(a.artist)}${a.offline ? '<span class="offline-badge">目录离线</span>' : ""}</p>
    <div class="album-facts">${fields.map(([name, value]) => `<div><small>${name}</small><span>${esc(String(value))}</span></div>`).join("")}</div>
    <div class="music-tabs" role="tablist" aria-label="专辑信息"><button role="tab" id="tab-tracks" data-tab="tracks" tabindex="${activeTab === "tracks" ? 0 : -1}" aria-selected="${activeTab === "tracks"}" aria-controls="album-tab-content"><span>01</span> 歌单</button><button role="tab" id="tab-about" data-tab="about" tabindex="${activeTab === "about" ? 0 : -1}" aria-selected="${activeTab === "about"}" aria-controls="album-tab-content"><span>02</span> 专辑介绍</button><i class="music-tab-indicator" aria-hidden="true"></i></div>
    <div id="album-tab-content" role="tabpanel" aria-labelledby="tab-${activeTab}">${activeTab === "tracks" ? trackList(a, discs) : albumAbout(a)}</div>`;
  article.scrollTop = scroll;
  syncAlbumNavigation();
  syncTabIndicator(false);
  documentDecryption.reset(
    article,
    preferences.reduced || scene?.decryptionFrame.phase === "clear",
  );
  updatePlayingRows();
}
function trackList(a: MusicAlbum, discs: number) {
  if (!a.tracks.length)
    return `<div class="empty-tracks"><strong>${demo ? "这是一张封面演示卡片" : "这个专辑还没有可播放曲目"}</strong><p>${demo ? "用于检查封面原始比例与卡片材质。扫描本地音乐库后，这里会显示真实曲目。" : "请检查音乐文件是否完整，并重新扫描音乐库。"}</p><button data-action="library">打开音乐库设置 ↗</button></div>`;
  let disc = -1;
  return `<div class="track-list" aria-label="专辑歌曲列表">${a.tracks
    .map((t, index) => {
      const discNo = t.discNumber || 1;
      const head =
        discs > 1 && discNo !== disc
          ? `<div class="disc-heading">DISC ${String(discNo).padStart(2, "0")}</div>`
          : "";
      disc = discNo;
      return `${head}<button class="track-row" data-track="${esc(t.id)}" ${a.offline ? "disabled" : ""} aria-label="播放 ${esc(t.title)}"><span class="track-number">${String(t.trackNumber || index + 1).padStart(2, "0")}</span><span class="track-name"><strong>${esc(t.title)}</strong><small>${esc(t.artist)}</small></span><span class="track-format">${esc(t.format)}${!t.browserPlayable ? '<i title="需要兼容的播放内核"> ↗</i>' : ""}</span><span class="track-duration">${time(t.duration)}</span></button>`;
    })
    .join("")}</div>`;
}
function albumAbout(a: MusicAlbum) {
  return `<section class="album-about"><small>ABOUT THIS ALBUM</small>
    ${a.description ? `<p>${esc(a.description)}</p>${a.descriptionSource ? `<a class="text-button" href="${esc(a.descriptionSource.url)}" target="_blank" rel="noopener">来源：${esc(a.descriptionSource.name)} ↗</a>${a.descriptionSource.license ? `<small class="introduction-license">${esc(a.descriptionSource.license)}</small>` : ""}` : ""}` : `<h3>专辑介绍待补充</h3><p>从公开百科核对专辑与歌手后读取介绍，附上来源并保存在本机。无法确认对应专辑时保留空白。</p>`}
    ${nativeAvailable() && !demo ? `<button data-action="introduction-album" class="text-button" ${introductionsStarting || library.introductions?.running ? "disabled" : ""}>${a.description ? "更新" : "查询"}专辑介绍 ↗</button><p class="introduction-feedback" data-introduction-feedback="${esc(a.id)}" role="status">${esc(introductionAlbumStatus(a))}</p>` : ""}
    <div class="source-note"><span>${demo ? "演示数据" : "本地音乐 · 文件保持只读"}</span><code>${esc(a.folder)}</code></div><div class="genre-tags">${a.rawGenres.map((g) => `<span>${esc(g)}</span>`).join("")}</div>${!demo ? `<label class="field-label" for="album-genre">手动分类</label><input id="album-genre" maxlength="80" value="${esc(genreName(a.genreId))}" aria-label="当前专辑分类"><button class="text-button" data-action="save-album-genre">保存分类 ↗</button>` : ""}</section>${producerBlock(a)}`;
}
function introductionAlbumStatus(a: MusicAlbum) {
  const lookup = a.introduction;
  if (lookup?.status === "error")
    return `介绍查询失败：${lookup.error || "资料来源暂时无法访问，请稍后重试。"}${a.description ? " 已有介绍仍然保留。" : ""}`;
  if (lookup?.status === "uncertain")
    return `找到可能的同名专辑，尚无法可靠确认，暂未采用介绍。${a.description ? " 已保留原有介绍。" : ""}`;
  if (lookup?.status === "not-found")
    return a.description
      ? "本次未找到可靠更新，已保留原有介绍。"
      : "未找到可核实的专辑介绍，可以稍后重试。";
  if (a.description) return "介绍已保存在本机，可离线阅读。";
  return "尚未查询专辑介绍。";
}
function metadataWaitStatus(job?: { retryAt?: number; waitingSource?: string }) {
  if (!job?.retryAt || job.retryAt <= Date.now()) return "";
  return `\n${job.waitingSource || "资料来源"}限流，等待至 ${new Date(job.retryAt).toLocaleTimeString("zh-CN")} 后自动重试；可取消，已完成的专辑会保留。`;
}
function updateIntroductionStatus() {
  const job = library.introductions;
  const running = introductionsStarting || !!job?.running;
  const button = document.querySelector<HTMLButtonElement>(
    "#introduction-refresh",
  );
  if (button) {
    button.disabled = running || !apiAvailable || !library.albums.length;
    button.textContent = running
      ? "正在查询专辑介绍…"
      : "查询 / 更新专辑介绍 ↗";
  }
  for (const control of document.querySelectorAll<HTMLButtonElement>(
    '[data-action="introduction-album"]',
  ))
    control.disabled = running || !apiAvailable;
  for (const feedback of document.querySelectorAll<HTMLElement>(
    "[data-introduction-feedback]",
  )) {
    const album = albums.find(
      (a) => a.id === feedback.dataset.introductionFeedback,
    );
    if (album)
      feedback.textContent = running
        ? "正在查询专辑介绍，已有资料仍可阅读。"
        : introductionAlbumStatus(album);
  }
  const progress = document.querySelector<HTMLProgressElement>(
    "#introduction-progress",
  );
  if (progress) {
    progress.hidden = !running;
    progress.max = Math.max(1, job?.total || 0);
    progress.value = job?.completed || 0;
    if (introductionsStarting && !job?.running)
      progress.removeAttribute("value");
  }
  const missing = library.albums.filter((album) => !album.description?.trim());
  const coverage = document.querySelector<HTMLElement>(
    "#introduction-coverage",
  );
  if (coverage)
    coverage.textContent = `已有介绍 ${library.albums.length - missing.length} / ${library.albums.length} 张 · 尚缺 ${missing.length} 张`;
  const status = document.querySelector<HTMLElement>("#introduction-status");
  if (status)
    status.textContent = !apiAvailable
      ? "本地音乐服务尚未连接，连接后可查询介绍。"
      : introductionRequestError
        ? `无法开始查询：${introductionRequestError}`
        : !library.albums.length
          ? "扫描本地音乐文件夹后，即可查询专辑介绍。"
          : introductionsStarting
            ? "正在提交专辑介绍查询…"
            : job?.running
              ? `已处理 ${job.completed} / ${job.total} 张 · 更新 ${job.updated} 张${job.currentAlbum ? `\n正在查询：${job.currentAlbum}` : ""}${metadataWaitStatus(job)}`
              : job?.error
                ? `查询未完成：${job.error}`
                : job && job.total > 0
                  ? `上次查询：处理 ${job.completed} / ${job.total} 张 · 更新 ${job.updated} 张 · 未找到可靠资料 ${job.notFound} 张 · 查询失败 ${job.failed} 张`
                  : "查询会核对专辑、歌手与年份；无法确认的结果不会覆盖已有介绍。";
  const details = document.querySelector<HTMLDetailsElement>(
    "#introduction-missing",
  );
  if (details) {
    details.hidden = !missing.length;
    details.querySelector("summary")!.textContent =
      `查看尚缺介绍的 ${missing.length} 张专辑`;
    details.querySelector("ul")!.innerHTML = missing
      .map(
        (album) =>
          `<li><strong>${esc(album.title)}</strong><span>${esc(album.artist)} · ${esc(introductionAlbumStatus(album))}</span></li>`,
      )
      .join("");
  }
}
function producerBlock(a: MusicAlbum) {
  const retry = a.creditsLookup && a.creditsLookup.status !== "unqueried";
  const disabled = creditsStarting || library.credits?.running || !apiAvailable || creditsCoolingDown(a);
  const groups = groupProducers(a);
  const people = new Set(groups.map((group) => group.person.name.normalize("NFKC").toLocaleLowerCase())).size;
  const tracks = new Set(groups.flatMap((group) => [...group.tracks.keys()])).size;
  return `<section class="producer-section" data-credits-album="${esc(a.id)}"><div class="producer-heading"><div><small>ALBUM CREDITS</small><h3>制作人员</h3></div>${nativeAvailable() && !demo ? `<button data-action="${retry ? "credits-retry" : "credits-album"}" ${disabled ? "disabled" : ""}>${retry ? "重新查询 ↻" : "查询制作信息 ↗"}</button>` : ""}</div>${groups.length ? `<p class="producer-overview">${people} 位参与人员${tracks ? ` · 涉及 ${tracks} 首曲目` : ""}<span>职责按下方曲目记录</span></p><ul class="producer-list">${groups.map((group) => {
    const entries = [...group.tracks.values()];
    const urls = [...new Set(group.entries.map((entry) => entry.url).filter(Boolean))];
    const source = producerSource({ ...group.person, url: urls.length === 1 ? urls[0] : undefined }, a);
    const trackMarkup = entries.length > 1
      ? `<details class="producer-tracks" data-credit-group="${esc(group.key)}"><summary>参与 ${entries.length} 首曲目<span aria-hidden="true">＋</span></summary><ul>${entries.map((track) => `<li><strong>${esc(track.title)}</strong><span>${[...track.roles].map(esc).join(" · ")}</span><small class="producer-source">来源：${[...new Map(track.entries.map((entry) => [entry.url || entry.source, entry])).values()].map((entry) => producerSource(entry, a)).join(" · ")}</small></li>`).join("")}</ul></details>`
      : entries.length === 1 ? `<p class="producer-track-note">参与曲目 · ${esc(entries[0].title)}${group.unscoped.size ? `<span>${[...entries[0].roles].map(esc).join(" · ")}</span>` : ""}</p>` : "";
    return `<li class="producer-person"><strong class="producer-name">${esc(group.person.name)}</strong><div class="producer-roles">${[...group.roles].map(esc).join(" · ")}</div><small class="producer-source">来源：${source}</small>${trackMarkup}${group.unscoped.size ? `<p class="producer-track-note">未细分曲目的署名 · ${[...group.unscoped].map(esc).join(" · ")}</p>` : ""}</li>`;
  }).join("")}</ul>` : "<p>设备媒体索引未提供制作人员资料。</p>"}${false ? `<p class="credits-feedback" data-credits-feedback="${esc(a.id)}" role="status" aria-live="polite">${esc(creditsAlbumStatus(a))}</p>` : ""}</section>`;
}
function groupProducers(album: MusicAlbum) {
  type Person = MusicAlbum["producers"][number];
  const groups = new Map<string, {
    key: string;
    person: Person;
    entries: Person[];
    roles: Set<string>;
    unscoped: Set<string>;
    tracks: Map<string, { title: string; roles: Set<string>; entries: Person[] }>;
  }>();
  for (const person of album.producers) {
    const key = JSON.stringify([person.name.trim().normalize("NFKC").toLocaleLowerCase(), person.source]);
    let group = groups.get(key);
    if (!group) {
      group = { key, person, entries: [], roles: new Set(), unscoped: new Set(), tracks: new Map() };
      groups.set(key, group);
    }
    group.entries.push(person);
    group.roles.add(person.role);
    const exactTrack = person.trackId ? album.tracks.find((track) => track.id === person.trackId) : undefined;
    const titleMatches = !exactTrack && person.trackTitle ? album.tracks.filter((track) => track.title === person.trackTitle) : [];
    const trackId = exactTrack?.id || (titleMatches.length === 1 ? titleMatches[0].id : undefined);
    const title = exactTrack?.title || person.trackTitle;
    if (title) {
      const trackKey = trackId || `title:${title}`;
      let track = group.tracks.get(trackKey);
      if (!track) {
        track = { title, roles: new Set(), entries: [] };
        group.tracks.set(trackKey, track);
      }
      track.roles.add(person.role);
      track.entries.push(person);
    } else group.unscoped.add(person.role);
  }
  return [...groups.values()];
}
function producerSource(producer: MusicAlbum["producers"][number], album: MusicAlbum) {
  const name = producer.source === "QQ Music" ? "QQ 音乐"
    : producer.source === "local" ? "本地标签"
    : producer.source === "manual" ? "手动补充" : producer.source;
  const candidate = producer.url || (producer.source === "MusicBrainz" ? album.online?.sourceUrl : undefined);
  if (candidate) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:")
        return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(name)} ↗</a>`;
    } catch { /* A missing or malformed source URL still keeps its source label. */ }
  }
  return esc(name);
}
function creditsCoolingDown(album: MusicAlbum) {
  return !!album.creditsLookup?.retryAt && Date.parse(album.creditsLookup.retryAt) > Date.now();
}
function creditsAlbumStatus(album: MusicAlbum) {
  if (!apiAvailable) return "本地音乐服务尚未连接，已有制作信息仍可阅读。";
  if (creditsRequestError && creditsRequestAlbumId === album.id)
    return `无法开始查询：${creditsRequestError}。已有制作信息仍然保留。`;
  if (creditsStarting || library.credits?.running)
    return "正在查询制作信息，已有资料仍可阅读，完成后自动更新。";
  const lookup = album.creditsLookup;
  const kept = album.producers.length ? " 已有制作信息仍然保留。" : "";
  const cooldown = creditsCoolingDown(album)
    ? ` 可在 ${new Date(lookup!.retryAt!).toLocaleString("zh-CN")} 后重新查询。` : "";
  if (lookup?.status === "partial")
    return `已取得 ${lookup.matchedTracks || 0} / ${lookup.totalTracks || album.tracks.length} 首曲目的参与人员，尚未覆盖整张专辑。${lookup.error ? ` ${lookup.error}` : ""}${cooldown}`;
  if (lookup?.status === "matched")
    return `制作信息已保存在本机，可离线阅读。${lookup.totalTracks ? ` 已核对 ${lookup.matchedTracks || 0} / ${lookup.totalTracks} 首曲目。` : ""}${cooldown}`;
  if (lookup?.status === "uncertain")
    return `尚无法可靠确认对应曲目，未采用存疑的参与人员。${kept}${cooldown}`;
  if (lookup?.status === "not-found")
    return `本次未找到可核实的制作信息。${kept}${cooldown}`;
  if (lookup?.status === "error")
    return `制作信息查询失败：${lookup.error || "资料来源暂时无法访问，请稍后重试。"}${kept}${cooldown}`;
  return "在线制作信息尚未查询。按曲目核对参与人员，本地标签和已有资料会保留。";
}
function creditsRunSummary(job: NonNullable<MusicLibrary["credits"]>) {
  return job.error ? `制作信息查询未完成：${job.error}`
    : job.total > 0
      ? `制作信息查询完成：更新 ${job.updated} 张，未找到可靠资料 ${job.notFound} 张，查询失败 ${job.failed} 张；曲目覆盖情况见各专辑。`
      : "当前没有需要查询的制作信息，已有缓存和查询冷却期会保留。";
}
function renderCurrentCredits() {
  const album = currentAlbum();
  const section = document.querySelector<HTMLElement>("#album-tab-content .producer-section");
  if (!album || !section || section.dataset.creditsAlbum !== album.id) return;
  const article = $("#album-detail-content");
  const scroll = article.scrollTop;
  const hadFocus = section.contains(document.activeElement);
  const openGroups = new Set([...section.querySelectorAll<HTMLDetailsElement>("details[open]")].map((details) => details.dataset.creditGroup));
  const focusedGroup = (document.activeElement as HTMLElement | null)?.closest<HTMLDetailsElement>("details[data-credit-group]")?.dataset.creditGroup;
  section.outerHTML = producerBlock(album);
  for (const details of document.querySelectorAll<HTMLDetailsElement>("#album-tab-content .producer-tracks")) {
    details.open = openGroups.has(details.dataset.creditGroup);
    if (hadFocus && focusedGroup === details.dataset.creditGroup)
      details.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
  }
  article.scrollTop = scroll;
  if (hadFocus && !focusedGroup)
    document.querySelector<HTMLButtonElement>("#album-tab-content .producer-section button")?.focus({ preventScroll: true });
}
function updateCreditsStatus() {
  const job = library.credits;
  const running = creditsStarting || !!job?.running;
  for (const control of document.querySelectorAll<HTMLButtonElement>(
    '[data-action="credits-album"], [data-action="credits-retry"]',
  )) {
    const album = currentAlbum();
    control.disabled = running || !apiAvailable || !album || creditsCoolingDown(album);
  }
  for (const feedback of document.querySelectorAll<HTMLElement>("[data-credits-feedback]")) {
    const album = albums.find((a) => a.id === feedback.dataset.creditsFeedback);
    if (album) feedback.textContent = creditsAlbumStatus(album);
  }
  const button = document.querySelector<HTMLButtonElement>("#credits-refresh");
  if (button) {
    button.disabled = running || !apiAvailable || !library.albums.length || demo;
    button.textContent = running ? "正在查询制作信息…" : "查询缺失的制作信息 ↗";
  }
  const progress = document.querySelector<HTMLProgressElement>("#credits-progress");
  if (progress) {
    progress.hidden = !running;
    progress.max = Math.max(1, job?.total || 0);
    progress.value = job?.completed || 0;
    if (creditsStarting && !job?.running) progress.removeAttribute("value");
  }
  const coverage = document.querySelector<HTMLElement>("#credits-coverage");
  if (coverage) {
    const withCredits = library.albums.filter((album) => album.producers.length > 0).length;
    const partial = library.albums.filter((album) => album.creditsLookup?.status === "partial").length;
    coverage.textContent = `已有制作信息 ${withCredits} / ${library.albums.length} 张${partial ? ` · 其中 ${partial} 张在线资料仅覆盖部分曲目` : ""}`;
  }
  const status = document.querySelector<HTMLElement>("#credits-status");
  if (status)
    status.textContent = !apiAvailable ? "本地音乐服务尚未连接，连接后可查询制作信息。"
      : creditsRequestError ? `无法开始查询：${creditsRequestError}`
      : !library.albums.length ? "扫描本地音乐文件夹后，即可查询制作信息。"
      : creditsStarting ? "正在提交制作信息查询…"
      : job?.running
        ? `已处理 ${job.completed} / ${job.total} 张 · 更新 ${job.updated} 张${job.currentAlbum ? `\n正在查询：${job.currentAlbum}` : ""}${job.trackTotal ? ` · 曲目 ${job.trackCompleted || 0} / ${job.trackTotal}` : ""}${metadataWaitStatus(job)}`
        : job ? creditsRunSummary(job)
          : "按需补充并缓存在本机；已有缓存不重复查询。重新核对单张专辑时，请使用详情中的重新查询。";
}
function updatePlayingRows() {
  document
    .querySelectorAll<HTMLButtonElement>("[data-track]")
    .forEach((row) => {
      const active = row.dataset.track === playerState?.currentTrack?.id;
      row.classList.toggle("playing", active);
      row.setAttribute("aria-current", String(active));
    });
}
let nowPlayingOpen = false;
let nowPlayingTrack = "";
let seeking = false;
const nowPlayingTransition = new SurfaceTransition($("#now-playing"), $("#now-playing"), 320, 240, "up",
  undefined, [$("#now-playing")], .94);
function paintNowRange(input: HTMLInputElement) {
  const min=Number(input.min), max=Number(input.max);
  const fraction=max>min ? (Number(input.value)-min)/(max-min) : 0;
  input.style.setProperty("--fill", `${Math.max(0,Math.min(1,fraction))*100}%`);
  if (input.id === "now-volume") $("#now-volume-value").textContent = `${Math.round(Number(input.value)*100)}%`;
}
function setNowPlaying(open: boolean) {
  const wasOpen = nowPlayingOpen;
  nowPlayingOpen = open && !!playerState?.currentTrack;
  if (nowPlayingOpen) nowPlayingTrack = "";
  const surface = $("#now-playing");
  surface.inert = !nowPlayingOpen;
  surface.setAttribute("aria-hidden", String(!nowPlayingOpen));
  if (nowPlayingOpen) {
    stage.dataset.nowPlaying = "true";
    nowPlayingTransition.show(preferences.reduced);
  } else nowPlayingTransition.hide(preferences.reduced, () => {
    if (!nowPlayingOpen) stage.dataset.nowPlaying = "false";
  });
  $("#transport-track").setAttribute("aria-expanded", String(nowPlayingOpen));
  if (nowPlayingOpen) $(".now-metadata").focus({ preventScroll: true });
  else if (wasOpen) $("#transport-track").focus({ preventScroll: true });
  updateNowPlaying();
  publishAndroidState();
}
function updateNowPlaying() {
  const state = playerState;
  if (!state) return;
  const track = state.currentTrack;
  if (!track && nowPlayingOpen) { setNowPlaying(false); return; }
  if (!nowPlayingOpen) return;
  const album = albums.find(album => album.id === track?.albumId);
  if (track?.id !== nowPlayingTrack) {
    nowPlayingTrack = track?.id || "";
    $("#now-title").textContent = track?.title || "";
    $("#now-artist").textContent = track?.artist || "";
    $("#now-album").textContent = album?.title || "";
    $("#now-cover").innerHTML = album ? cover(album) : "";
    const backdrop = $<HTMLImageElement>("#now-backdrop");
    backdrop.hidden = !album?.coverUrl;
    if (album?.coverUrl) backdrop.src = album.coverUrl;
    else backdrop.removeAttribute("src");
  }
  const seek = $<HTMLInputElement>("#now-seek");
  seek.max = String(Math.max(1, state.duration));
  if (!seeking) seek.value = String(state.currentTime);
  seek.disabled = !track || state.duration <= 0;
  paintNowRange(seek);
  $("#now-elapsed").textContent = time(state.currentTime);
  $("#now-duration").textContent = time(state.duration);
  $("#now-playing").dataset.playing = String(state.playing);
  $("#now-toggle").setAttribute("aria-pressed", String(state.playing));
  $("#now-toggle").setAttribute("aria-label", state.playing ? "暂停" : "播放");
  const volume = $<HTMLInputElement>("#now-volume");
  if (document.activeElement !== volume) volume.value = String(state.volume);
  paintNowRange(volume);
  $("#now-error").textContent = state.error || "";
}
$("#now-seek").addEventListener("input", event => { const input=event.target as HTMLInputElement; paintNowRange(input); $("#now-elapsed").textContent = time(Number(input.value)); });
$("#now-seek").addEventListener("pointerdown", () => { seeking = true; });
$("#now-seek").addEventListener("pointercancel", () => { seeking = false; });
$("#now-seek").addEventListener("pointerup", () => { seeking = false; });
$("#now-seek").addEventListener("change", event => { seeking = false; player.seek(Number((event.target as HTMLInputElement).value)); });
$("#now-volume").addEventListener("input", event => {
  const input=event.target as HTMLInputElement; paintNowRange(input);
  preferences.volume = Number(input.value); player.setVolume(preferences.volume); savePrefs();
});
let lastPlayerError = "";
let lastTransitionWarning = "";
const transportTitleMotion = setupTransportTitle(
  $<HTMLButtonElement>("#transport-track"),
  $("#transport-track-label"),
);
transportTitleMotion.setReduced(preferences.reduced);
player.subscribe((state) => {
  playerState = state;
  const transport = $(".minimal-transport");
  transport.dataset.backend = state.backend;
  transport.dataset.transport = state.transport;
  transport.dataset.position = String(state.currentTime);
  transport.dataset.duration = String(state.duration);
  const titleVisible = !!state.currentTrack;
  transportTitleMotion.update(state.currentTrack?.title ?? "", titleVisible);
  $("#play-pause").setAttribute("aria-pressed", String(state.playing));
  $("#play-pause").setAttribute(
    "aria-label",
    state.playing ? "暂停" : "播放",
  );
  $("#play-pause").title = state.currentTrack
    ? `${state.playing ? "暂停" : "播放"}：${state.currentTrack.title}`
    : "播放当前专辑";
  if (state.error && state.error !== lastPlayerError) notify(state.error);
  lastPlayerError = state.error || "";
  if (state.transitionWarning && state.transitionWarning !== lastTransitionWarning && !state.error)
    notify(state.transitionWarning);
  lastTransitionWarning = state.transitionWarning || "";
  updateNowPlaying();
  const nativeOutput=document.querySelector<HTMLSelectElement>("#native-audio-device");
  if(nativeOutput && document.activeElement!==nativeOutput) { nativeOutput.innerHTML=state.outputDevices.map(device=>`<option value="${esc(device.id)}">${esc(device.name)}</option>`).join(""); nativeOutput.value=state.outputDeviceId; }
  updatePlayingRows();
  syncAudioOutputUI();
});

function audioOutputMarkup() {
  return `<section class="panel-section"><h3>音频输出</h3><label class="settings-row"><span>输出方式<small>歌曲播放使用的音频内核</small></span><select id="audio-backend" aria-label="音频输出方式"><option value="browser">浏览器输出</option><option value="coreaudio">Mac 原生 CoreAudio</option></select></label><label class="settings-row" id="audio-device-row"><span>输出设备<small>仅改变本播放器的歌曲输出</small></span><select id="audio-device" aria-label="音频输出设备"></select></label><p id="audio-output-status" role="status"></p><button class="text-button" data-action="refresh-output">刷新输出设备 ↻</button><p>APE、FLAC、WAV 等格式在本机解码；DSF / DFF 在本机转为 PCM 播放，源文件保持不变。原生输出直接连接所选设备；浏览器输出沿用浏览器的声音设备。</p></section>`;
}
function syncAudioOutputUI() {
  const backend = document.querySelector<HTMLSelectElement>("#audio-backend");
  if (!backend || !playerState) return;
  backend.value = playerState.backend;
  backend.disabled = outputBusy || !apiAvailable || lightingDemo;
  backend.options[1].disabled = !playerState.nativeAvailable;
  const device = $<HTMLSelectElement>("#audio-device");
  const items = playerState.outputDevices;
  const key = JSON.stringify(items);
  if (device.dataset.devices !== key) {
    device.innerHTML = items.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
    device.dataset.devices = key;
  }
  device.value = playerState.outputDeviceId;
  device.disabled = outputBusy || playerState.backend !== "coreaudio";
  $("#audio-device-row").hidden = playerState.backend !== "coreaudio";
  $("#audio-output-status").textContent = lightingDemo ? "演示模式只展示封面；请通过音乐播放器启动器使用音频输出。" :
    !apiAvailable ? "请通过音乐播放器启动器连接本机音频服务。" : outputBusy ? "正在连接音频输出…" :
    playerState.outputError || playerState.transitionWarning || outputStatus;
  $<HTMLButtonElement>('[data-action="refresh-output"]').disabled = outputBusy || !apiAvailable || lightingDemo;
}
async function refreshAudioOutputs(restore = false) {
  if (lightingDemo || !apiAvailable) { syncAudioOutputUI(); return; }
  outputBusy = true; syncAudioOutputUI();
  try {
    const capabilities = await player.refreshOutputs();
    audioOutputsChecked = true;
    outputStatus = capabilities.decoderAvailable ? capabilities.nativeAvailable ?
      "本机解码与 CoreAudio 已就绪。" : "本机解码已就绪；原生输出暂不可用。" :
      "未检测到 FFmpeg，当前仅可播放浏览器支持的格式。";
    if (restore && preferences.audioBackend === "coreaudio")
      await player.setBackend("coreaudio", preferences.outputDeviceId);
  } catch (error) { outputStatus = (error as Error).message; }
  finally { outputBusy = false; syncAudioOutputUI(); }
}
async function changeAudioOutput(backend: "browser" | "coreaudio", deviceId: string) {
  if (outputBusy) return;
  outputBusy = true; syncAudioOutputUI();
  try {
    if (backend !== playerState.backend) await player.setBackend(backend, deviceId);
    else await player.setOutputDevice(deviceId);
    preferences.audioBackend = player.state.backend;
    preferences.outputDeviceId = player.state.outputDeviceId;
    savePrefs();
    outputStatus = backend === "coreaudio" ? "歌曲通过 Mac 原生设备输出。" : "歌曲通过浏览器输出。";
  } catch (error) { outputStatus = (error as Error).message; notify(outputStatus); }
  finally { outputBusy = false; syncAudioOutputUI(); }
}

let panelFocus: HTMLElement | null = null;
let panelTransition: SurfaceTransition | undefined,
  panelClosing = false,
  pendingPanelAfter: (() => void) | undefined;
function closePanel(after?: () => void) {
  if (!panel) {
    after?.();
    return;
  }
  pendingPanelAfter = after;
  if (panelClosing) return;
  panelClosing = true;
  panelTransition?.hide(preferences.reduced, () => {
    panel = null;
    publishAndroidState();
    panelClosing = false;
    panelTransition?.dispose();
    panelTransition = undefined;
    $("#music-panel-root").innerHTML = "";
    for (const node of [
      $("#music-browse"),
      $("#music-detail"),
      $(".music-header"),
      $("#three-scene"),
    ])
      node.inert = false;
    $("#music-browse").inert = presentation.phase !== "archive";
    if (overview) $("#music-browse").inert = true;
    $("#music-overview").inert = !overview;
    $<HTMLButtonElement>('[data-action="overview"]').inert = overview;
    $("#music-detail").inert = presentation.phase !== "detail";
    stage.querySelectorAll<HTMLElement>(".lighting-lab").forEach((debugPanel) => { debugPanel.inert = false; });
    panelFocus?.focus({ preventScroll: true });
    const next = pendingPanelAfter;
    pendingPanelAfter = undefined;
    next?.();
  });
}
function openPanel(next: Panel) {
  if (!next) return closePanel();
  cancelTrackReveal();
  panelTransition?.dispose();
  pendingPanelAfter = undefined;
  panelClosing = false;
  if (!panel) panelFocus = document.activeElement as HTMLElement;
  panel = next;
  publishAndroidState();
  $("#music-overview").inert = true;
  $<HTMLButtonElement>('[data-action="overview"]').inert = true;
  stage.querySelectorAll<HTMLElement>(".lighting-lab").forEach((debugPanel) => { debugPanel.inert = true; });
  const titles = {
    library: ["MUSIC LIBRARY", "本地音乐库"],
    search: ["FIND MUSIC", "搜索专辑与歌曲"],
    settings: ["SYSTEM SETTINGS", "播放与画质"],
  };
  $("#music-panel-root").innerHTML =
    `<div class="music-panel-scrim" data-action="dismiss-panel"><section class="music-panel" role="dialog" aria-modal="true" aria-labelledby="music-panel-title"><div class="panel-heading"><div><small>${titles[next][0]}</small><h2 id="music-panel-title">${titles[next][1]}</h2></div><button data-action="close-panel" aria-label="关闭">×</button></div><div id="panel-body"></div></section></div>`;
  for (const node of [
    $("#music-browse"),
    $("#music-detail"),
    $(".music-header"),
    $("#three-scene"),
  ])
    node.inert = true;
  const scrim = $(".music-panel-scrim");
  scrim.hidden = true;
  panelTransition = new SurfaceTransition(scrim, $(".music-panel"));
  panelTransition.show(preferences.reduced);
  effects.play("page-open");
  if (next === "library") renderLibraryPanel();
  if (next === "search") renderSearchPanel();
  if (next === "settings") renderSettingsPanel();
  (
    document.querySelector<HTMLElement>("#album-search") ||
    $("#music-panel-root button")
  )?.focus({ preventScroll: true });
}
function renderLibraryPanel() {
  $("#panel-body").innerHTML = `<p class="panel-intro">系统媒体库适合快速扫描大规模曲库；也可选择音乐文件夹导入未入库的音频。源文件与标签保持只读。</p><div class="library-metrics"><div><b>${library.albums.length}</b><span>专辑</span></div><div><b>${library.albums.reduce((n,a)=>n+a.tracks.length,0)}</b><span>曲目</span></div></div><div class="panel-actions"><button data-action="scan">授权并扫描设备音乐 ↗</button><button data-action="choose-folder">添加音乐文件夹 ↗</button><button data-action="cancel-scan">取消扫描</button><button data-action="app-settings">权限设置</button></div><p id="scan-status" role="status"></p><section class="panel-section"><h3>已选文件夹</h3>${library.roots.filter(root=>root.path.startsWith("content:")).map(root=>`<p class="source-note"><span>${esc(root.label || "音乐文件夹")}</span><button class="text-button" data-remove-folder="${esc(root.path)}">移除索引</button></p>`).join("") || "<p>尚未添加文件夹。</p>"}<p>文件夹首扫需要读取标签，后续复用未改变文件的索引；移除只解除授权和索引，不删除音乐。系统已索引的共享存储适合接近一万首的库。</p></section>`;
  updateScanStatus();
}
function renderMusicBrainzSettings() {
  const configSection = document.querySelector<HTMLElement>("#online-config");
  if (!configSection) return;
  void (async () => {
    try {
      const config = await request<{
        musicBrainzContact?: string;
        musicBrainzConfigured?: boolean;
        onlineEnabled?: boolean;
      }>("/api/config");
      if (!configSection.isConnected) return;
      configSection.innerHTML = `<h3>资料库连接</h3><label class="field-label" for="metadata-contact">资料查询联系邮箱或项目网址</label><input id="metadata-contact" type="text" value="${esc(config.musicBrainzContact || "")}" placeholder="你的联系邮箱或公开项目网址"><p>用于维基百科与 MusicBrainz 请求的应用标识，不用于注册或订阅。未填写时，百科查询采用较慢的匿名访问速率；MusicBrainz 查询需要先填写。</p><label class="settings-row"><span>扫描后自动补充新专辑资料<small>已有缓存不重复查询；断网仍可浏览与播放</small></span><input type="checkbox" id="online-enabled" ${config.onlineEnabled ? "checked" : ""}></label><button class="text-button" data-action="save-online">保存资料库设置 ↗</button><p>${config.musicBrainzConfigured ? "资料库请求标识已配置。" : "尚未配置；本地曲库和播放已可使用。"}</p>`;
    } catch (error) {
      if (configSection.isConnected)
        configSection.innerHTML = `<p>${esc((error as Error).message)}</p>`;
    }
  })();
}
function updateScanStatus() {
  const el = document.querySelector("#scan-status");
  if (el)
    el.textContent = library.scan.running
      ? "正在扫描，已有曲库可以继续浏览…"
      : library.scan.error ||
        library.roots
          .filter((r) => r.status === "offline")
          .map((r) => `${r.label || r.path} 暂时离线，原索引已保留。`)
          .join("\n") ||
        (library.scan.finishedAt
          ? `上次扫描 ${new Date(library.scan.finishedAt).toLocaleString("zh-CN")}`
          : "尚未扫描音乐目录。");
}
function renderSearchPanel() {
  $("#panel-body").innerHTML =
    `<input class="album-search" id="album-search" type="search" placeholder="专辑、歌曲、歌手、流派…" aria-label="搜索专辑与歌曲"><div class="genre-filters"><button data-filter="" class="active">全部</button>${genres
      .filter((g) => albums.some((a) => a.genreId === g.id))
      .map((g) => `<button data-filter="${esc(g.id)}">${esc(g.name)}</button>`)
      .join("")}</div><div id="album-results"></div>`;
  renderSearchResults();
}
let searchGenre = "";
let searchTimer: ReturnType<typeof setTimeout> | undefined;
function renderSearchResults() {
  if (!document.querySelector("#album-results")) return;
  const query = ($<HTMLInputElement>("#album-search")?.value || "")
    .trim()
    .toLocaleLowerCase();
  const results: string[] = [];
  for (const result of searchMusicLibrary(albums, genres, query, searchGenre)) {
    const a = result.album;
    if (result.kind === 'album') {
      results.push(`<button class="album-result" data-album="${esc(a.id)}"><span class="result-cover">${cover(a)}</span><span class="result-copy"><strong>${esc(a.title)}</strong><small>${esc(a.artist)} · ${esc(genreName(a.genreId))}</small></span><em>专辑</em><i>↗</i></button>`);
    } else {
      const track = result.track!;
      // Preserve the exact song identity; selecting a result navigates without playing.
      results.push(`<button class="album-result song-result" data-album="${esc(a.id)}" data-search-track="${esc(track.id)}" aria-label="定位歌曲 ${esc(track.title)}，${esc(a.title)}"><span class="result-cover">${cover(a)}</span><span class="result-copy"><strong>${esc(track.title)}</strong><small>${esc(track.artist)} · ${esc(a.title)}</small></span><em>歌曲</em><i>↗</i></button>`);
    }
  }
  $("#album-results").innerHTML = results.length
    ? results.join("") + (results.length >= 120 ? '<p class="search-limit">显示前 120 项，请细化关键词缩小范围。</p>' : "")
    : '<div class="no-results">没有找到专辑或歌曲。</div>';
}
function renderSettingsPanel() {
  $("#panel-body").innerHTML =
    `<section class="panel-section"><h3>外观主题</h3><div class="theme-cards">${(["day", "night"] as Theme[]).map((t) => `<button data-theme="${t}" aria-pressed="${preferences.theme === t}" class="${t}"><i></i><strong>${themeNames[t]}</strong><span>${t === "day" ? "暖白玻璃与日光" : "极简星空与透光白卡"}</span></button>`).join("")}</div></section>
    <section class="panel-section"><h3>音乐库排列</h3><label class="settings-row"><span>排列方式<small>切换后重新载入界面</small></span><select id="music-sort" aria-label="音乐库排列方式">${(["genre", "artist", "album"] as MusicSortMode[]).map((value) => `<option value="${value}" ${preferences.sortMode === value ? "selected" : ""}>${sortLabels[value].name}</option>`).join("")}</select></label></section>
    <section class="panel-section" id="introduction-settings"><h3>专辑介绍</h3><button class="text-button" data-action="cancel-metadata">取消资料查询</button><p>从公开百科查询并更新专辑介绍，附上资料来源。介绍保存在本机，音乐文件不会上传。</p><p id="introduction-coverage"></p><button class="primary-button" id="introduction-refresh" data-action="introductions-library">查询 / 更新专辑介绍 ↗</button><progress id="introduction-progress" aria-label="专辑介绍查询进度" max="1" value="0" hidden></progress><p id="introduction-status" class="scan-status" role="status" aria-live="polite"></p><details id="introduction-missing" hidden><summary></summary><ul></ul></details></section>
    <section class="panel-section" id="credits-settings"><h3>制作信息</h3><p>从 QQ 音乐核对曲目的参与人员，在姓名下方注明来源。批量查询按来源限速排队，可随时取消。保留本地标签与已有资料，查询结果保存在本机。</p><p id="credits-coverage"></p><button class="primary-button" id="credits-refresh" data-action="credits-library">查询缺失的制作信息 ↗</button><progress id="credits-progress" aria-label="制作信息查询进度" max="1" value="0" hidden></progress><p id="credits-status" class="scan-status" role="status" aria-live="polite"></p></section>
    <section class="panel-section"><h3>高级设置 · 专辑阵列</h3><label class="settings-row"><span>专辑列显示</span><select id="music-array-mode" aria-label="专辑列显示方式"><option value="filled" ${preferences.arrayMode === "filled" ? "selected" : ""}>填充画面</option><option value="realistic" ${preferences.arrayMode === "realistic" ? "selected" : ""}>真实专辑列</option></select></label><p>真实专辑列：各列独立居中；上下浏览到本列首尾时停止。</p><label class="settings-row"><span>保留每列浏览位置<small>关闭后保持画面深度，选中邻近专辑</small></span><input type="checkbox" id="remember-column-position" ${preferences.rememberColumnPosition ? "checked" : ""}></label></section>
    <section class="panel-section"><h3>原生音频输出</h3><label class="settings-row"><span>偏好输出设备<small>实际路由由 Android 和设备能力决定</small></span><select id="native-audio-device" aria-label="偏好音频输出设备">${playerState.outputDevices.map(device=>`<option value="${esc(device.id)}" ${device.id===playerState.outputDeviceId?"selected":""}>${esc(device.name)}</option>`).join("")}</select></label><button class="text-button" data-action="native-refresh-output">刷新输出设备 ↻</button><p>Media3 原生解码与系统音频焦点；不会改变系统音量或请求独占输出。</p></section>
    ${qualityMarkup(renderQuality, nativeVulkan)}
    ${nativeVulkan ? `<section class="panel-section"><h3>焦点层次</h3><label class="settings-row"><span>轻度景深与边缘高光<small>选中专辑及附近保持清晰，向远处逐渐柔化</small></span><input type="checkbox" id="focus-depth" ${preferences.focusDepth !== false ? "checked" : ""}></label><p>默认开启，可关闭对照。</p></section>` : ""}
    ${experimentalOpticsAvailable ? `<section class="panel-section" id="experimental-optics-settings"><h3>实验性画面 · RC</h3><label class="settings-row"><span>柔光与景深<small>边缘柔光与远近虚化，保留文字清晰</small></span><input type="checkbox" id="experimental-optics" ${preferences.experimentalOptics === true ? "checked" : ""}></label><p>默认关闭，可即时对比；开启后会增加 GPU 开销，流畅度下降时关闭即可。</p></section>` : ""}
    <section class="panel-section"><h3>专辑光带</h3>${([['strength','强度',0,2,.05],['width','宽度',.6,2.5,.05],['offset','位置偏移',-6,6,.1],['fill','补光',0,1,.05],['transitionDuration','跟随时间',.4,2.4,.1]] as const).map(([key,label,min,max,step])=>`<label class="settings-row"><span>${label}</span><input type="range" data-native-light="${key}" min="${min}" max="${max}" step="${step}" value="${normalizeRowLighting(preferences.lighting||{},DEFAULT_LIGHTING_PRESET)[key]}" aria-label="光带${label}"></label>`).join('')}</section>
    <section class="panel-section"><h3>动效与显示</h3><label class="settings-row"><span>减少动态效果</span><input type="checkbox" id="reduced-motion" ${preferences.reduced ? "checked" : ""}></label><label class="settings-row"><span>动画速度<small>专辑、镜头、文字与光带同步；不改变歌曲或片头速度</small></span><input id="native-motion-speed" aria-label="动画速度" type="range" min="0.25" max="3" step="0.05" value="${preferences.motionSpeed}"><output id="native-motion-value">${preferences.motionSpeed.toFixed(2)}×</output></label><label class="settings-row"><span>静置轻微浮动<small>沿用原版微幅运动，开启后持续渲染</small></span><input id="idle-motion" type="checkbox" ${preferences.idleMotion?"checked":""}></label><button class="text-button" data-action="fullscreen">切换当前方向全屏 ↗</button><button class="text-button" data-action="replay-boot">重播开场 ↗</button><button class="text-button" data-action="reload-interface">重新载入界面 ↻</button></section>
    <section class="panel-section"><h3>声音</h3><label class="settings-row"><span>歌曲音量</span><input type="range" id="volume" aria-label="歌曲音量" min="0" max="100" value="${Math.round(preferences.volume * 100)}"></label><label class="settings-row"><span>歌曲衔接<small>选择切换歌曲时的音量过渡</small></span><select id="song-fade-setting" aria-label="歌曲衔接方式"><option value="fade-out" ${preferences.songTransition === "fade-out" ? "selected" : ""}>淡出但不淡入</option><option value="fade-in-out" ${preferences.songTransition === "fade-in-out" ? "selected" : ""}>淡出淡入</option><option value="gapless" ${preferences.songTransition === "gapless" ? "selected" : ""}>无缝播放</option></select></label><label class="settings-row"><span>界面音效<small>玻璃卡片与终端操作</small></span><input type="checkbox" id="sound-setting" ${preferences.sound ? "checked" : ""}></label><label class="settings-row"><span>音效音量</span><input type="range" id="sound-volume" aria-label="音效音量" min="0" max="100" value="${Math.round(preferences.soundVolume * 100)}"></label><label class="settings-row"><span>氛围 BGM<small>专辑开始前淡出，停止后淡入</small></span><input type="checkbox" id="bgm-setting" ${preferences.bgm ? "checked" : ""}></label><label class="settings-row"><span>BGM 音量</span><input type="range" id="bgm-volume" aria-label="BGM 音量" min="0" max="100" value="${Math.round(preferences.bgmVolume * 100)}"></label><button class="text-button" data-action="sound-preview">试听界面音效 ↗</button><p>歌曲和氛围音乐由原生服务播放，界面音效独立控制。手动切歌每段淡变约 450ms；曲尾交给 Media3 连续排程。不同格式、采样率或输出设备可能产生间隙，保留文件自带静音。</p></section>
    <details class="panel-section" id="musicbrainz-settings"><summary>高级设置 · MusicBrainz</summary><p>向 MusicBrainz 查询专辑名称与艺术家，补充流派和制作人员；音乐文件留在本机。已有资料使用缓存，人工分类优先保留。</p><button data-action="enrich-library" class="text-button">补充缺失的在线资料 ↗</button><div id="online-config"><p>正在读取资料库设置…</p></div></details>
    <section class="panel-section"><h3>诊断与日志</h3><button class="text-button" data-action="export-log">导出运行日志 ZIP ↗</button><p>保存设备信息、渲染状态与近期错误记录，不打包音乐和封面。错误记录可能包含文件名，请按需分享。</p><button class="text-button" data-action="copy-performance">复制性能诊断 ↗</button><p>RhineDroid · ${esc(appVersion)}<br>设备曲库 · 原生音频 · ${nativeVulkan ? "Vulkan GPU 渲染" : "浏览器预览"}。</p><p>音乐界面：RonaldDeng<br>原版界面：LBEILC / RhineLabUI</p><p><a href="https://github.com/RonaldDeng/Rhine-Music-Demo" target="_blank" rel="noopener">上游项目 ↗</a> · <a href="/licenses/project-mit.txt">代码许可 ↗</a></p></section>`;
  renderMusicBrainzSettings();
  updateIntroductionStatus(); updateCreditsStatus();
  updateQuality();
}
function updateQuality() {
  renderQuality = normalizeQuality(renderQuality);
  preferences.renderQuality = renderQuality;
  scene?.setQuality(renderQuality);
  viewer?.setQuality(renderQuality);
  syncQualityUI(renderQuality);
  const summary = document.querySelector("#quality-summary");
  if (summary)
    summary.textContent = `渲染 ${renderQuality.scale}% · 像素上限 ${renderQuality.pixelRatio}× · ${nativeVulkan ? "Vulkan · FXAA" : renderQuality.antialias === "off" ? "原始抗锯齿" : "SMAA"}`;
  savePrefs();
}
async function editGenres() {
  const body = document.querySelector("#panel-body");
  try {
    const rules = await request<GenreRules>("/api/genre-rules");
    if (!body?.isConnected || panel !== "library") return;
    body.innerHTML = `<p class="panel-intro">这里编辑展示流派、别名和专辑人工分类。保存后重新归并本地索引，不修改音频标签。</p><label class="field-label" for="genre-json">本地流派规则</label><textarea id="genre-json" class="json-editor" spellcheck="false">${esc(JSON.stringify(rules, null, 2))}</textarea><div class="panel-actions"><button data-action="save-genres" class="primary-button">保存并应用</button><button data-action="library">返回音乐库</button></div><p id="genre-error" role="alert"></p>`;
  } catch (error) {
    notify((error as Error).message);
  }
}
async function scan(_saveRoots = false) {
  if (scanSubmitting) return;
  scanSubmitting = true;
  try { await nativeCommand("scan"); }
  catch (error) { notify((error as Error).message); }
  finally { scanSubmitting = false; }
}
async function enrich(one = false) {
  if (demo) return;
  try {
    await request(
      "/api/library/enrich",
      one ? { albumIds: [currentAlbum()!.id] } : {},
    );
    notify("已开始补充流派和制作资料，结果将缓存在本机。");
    await loadLibrary();
  } catch (error) {
    notify((error as Error).message);
  }
}
async function queryIntroductions(one = false) {
  const album = currentAlbum();
  if (demo || !library.albums.length || (one && !album)) return;
  if (introductionsStarting || library.introductions?.running) {
    notify("专辑介绍正在查询，进度可在设置中查看。");
    return;
  }
  introductionsStarting = true;
  introductionRequestError = "";
  updateIntroductionStatus();
  try {
    const next = await request<MusicLibrary>("/api/library/introductions", {
      ...(one ? { albumIds: [album!.id] } : {}),
      force: one,
    });
    // A GET started before this accepted job must not restore an older snapshot.
    libraryStateVersion++;
    apiAvailable = true;
    await receiveLibrary(next);
    const job = next.introductions;
    notify(
      job?.running
        ? `${one ? "这张专辑" : "音乐库"}的介绍查询已开始，可在设置中查看进度。`
        : job?.error ||
            (job && job.total > 0
              ? `专辑介绍查询完成：更新 ${job.updated} 张，未找到可靠资料 ${job.notFound} 张，查询失败 ${job.failed} 张。`
              : "当前没有需要查询的专辑。"),
    );
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void loadLibrary(), 800);
  } catch (error) {
    introductionRequestError = (error as Error).message;
    notify(introductionRequestError);
  } finally {
    introductionsStarting = false;
    updateIntroductionStatus();
  }
}
async function queryCredits(one = false, force = false) {
  const album = currentAlbum();
  if (demo || !library.albums.length || (one && !album)) return;
  if (creditsStarting || library.credits?.running) return;
  if (one && creditsCoolingDown(album!)) {
    notify(creditsAlbumStatus(album!));
    return;
  }
  creditsStarting = true;
  creditsRequestError = "";
  creditsRequestAlbumId = one ? album!.id : undefined;
  updateCreditsStatus();
  try {
    const next = await request<MusicLibrary>("/api/library/credits", {
      ...(one ? { albumIds: [album!.id] } : {}),
      force,
    });
    ++libraryStateVersion;
    apiAvailable = true;
    const previousRunning = library.credits?.running;
    await receiveLibrary(next);
    if (next.credits?.running)
      notify(`${one ? "这张专辑" : "音乐库"}的制作信息查询已开始，完成后自动显示；已有资料仍可阅读。`);
    else if (!previousRunning && next.credits)
      notify(creditsRunSummary(next.credits));
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void loadLibrary(), 800);
  } catch (error) {
    creditsRequestError = (error as Error).message;
    notify(`无法开始制作信息查询：${creditsRequestError}`);
  } finally {
    creditsStarting = false;
    updateCreditsStatus();
  }
}
function playAlbum(id?: string) {
  const a = currentAlbum();
  if (!a?.tracks.length || a.offline) return;
  void player.play(id || a.tracks[0].id, a.tracks);
}

document.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest('[data-action="reload-interface"]')) {
    disposePage();
    location.reload();
    return;
  }
  if (boot?.active) return;
  const target = (e.target as HTMLElement).closest<HTMLElement>(
    "button, [data-action]",
  );
  if (!target) return;
  if (target.dataset.overviewLane !== undefined) {
    overviewUI.expand(Number(target.dataset.overviewLane));
    return;
  }
  if (target.dataset.overviewEnterLane !== undefined) {
    const lane = Number(target.dataset.overviewEnterLane);
    if (!overviewUI.canEnter(lane)) return;
    const targetColumn = resolveColumnSelection(lane);
    const navigation = targetColumn.row === undefined ? undefined : {
      cell: scene?.musicColumnCell(lane, targetColumn.row) ?? { lane, row: targetColumn.row },
      guided: true,
    };
    // The shared preference chooses an album; reveal browse text only after the
    // rail and near camera settle. Entry never opens album details.
    select(targetColumn.index, navigation, false);
    setOverview(false);
    return;
  }
  if (target.dataset.action === "dismiss-panel" && e.target !== target) return;
  if (target.dataset.theme) {
    setTheme(target.dataset.theme as Theme);
    return;
  }
  if (target.dataset.track) {
    playAlbum(target.dataset.track);
    return;
  }
  if (target.dataset.select) {
    const rulerStep = Number(target.dataset.rulerStep);
    select(Number(target.dataset.select),
      target.dataset.rulerStep !== undefined && Number.isInteger(rulerStep)
        ? { axis: "row", direction: rulerStep } : undefined);
    return;
  }
  if (target.dataset.album) {
    revealAlbum(target.dataset.album, target.dataset.searchTrack);
    return;
  }
  if (target.dataset.tab) {
    setTab(target.dataset.tab as "tracks" | "about");
    return;
  }
  if (target.dataset.filter !== undefined) {
    searchGenre = target.dataset.filter;
    document
      .querySelectorAll("[data-filter]")
      .forEach((b) =>
        b.classList.toggle(
          "active",
          (b as HTMLElement).dataset.filter === searchGenre,
        ),
      );
    renderSearchResults();
    return;
  }
  if(target.dataset.removeFolder) { void nativeCommand("remove-folder",{uri:target.dataset.removeFolder}).then(()=>loadLibrary(true)).catch(error=>notify(error.message)); return; }
  const action = target.dataset.action;
  if (["library", "search", "settings"].includes(action || "")) {
    searchGenre = "";
    openPanel(action as Panel);
    return;
  }
  switch (action) {
    case "choose-folder": void nativeCommand("choose-folder").catch(error=>notify(error.message)); break;
    case "native-refresh-output": void nativeCommand("audio-outputs").catch(error=>notify(error.message)); break;
    case "cancel-metadata": void request("/api/library/cancel-metadata",{}).then(()=>notify("已请求取消资料查询，已有资料保留")).catch(error=>notify(error.message)); break;
    case "save-album-genre": void (async()=>{try { await request("/api/album/genre",{albumId:currentAlbum()?.id,genre:$<HTMLInputElement>("#album-genre").value}); await loadLibrary(true); notify("分类已保存，音乐标签保持原样"); } catch(error) {notify((error as Error).message);} })(); break;
    case "toggle-now-playing": setNowPlaying(!nowPlayingOpen); break;
    case "next-track": player.next(); break;
    case "previous-track": player.previous(); break;
    case "app-settings": void nativeCommand("app-settings").catch(error => notify(error.message)); break;
    case "orientation": void nativeCommand("orientation").catch(error => notify(error.message)); break;
    case "cancel-scan": void nativeCommand("cancel-scan").catch(error => notify(error.message)); break;
    case "copy-performance":
      void copyPerformanceReport();
      break;
    case "export-log": void exportLog(); break;
    case "reload-interface":
      disposePage();
      location.reload();
      break;
    case "refresh-output":
      void refreshAudioOutputs();
      break;
    case "overview-return":
      setOverview(false);
      break;
    case "overview":
      setOverview(!overview);
      break;
    case "replay-boot":
      closePanel(() => { setOverview(false, false); boot?.replay(); });
      break;
    case "lighting-debug":
      closePanel(() => {
        setMode("archive");
        lightingControls?.focus();
      });
      break;
    case "motion-debug":
      closePanel(() => {
        setMode("archive");
        motionControls?.focus();
      });
      break;
    case "locate-playing": {
      setNowPlaying(false);
      const track = playerState.currentTrack;
      if (track) revealAlbum(track.albumId, track.id, { reuseOpenAlbum: true });
      break;
    }
    case "close-panel":
    case "dismiss-panel":
      closePanel();
      break;
    case "open":
      setMode("detail");
      break;
    case "back":
      setMode("archive");
      break;
    case "model-viewer":
      // Temporarily unavailable for the simplified CD shell (no inner assembly).
      break;
    case "sound-preview":
      effects.play("page-open");
      break;
    case "fullscreen":
      if(nativeAvailable()) { void nativeCommand("fullscreen").catch(error=>notify(error.message)); break; }
      void (
        document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen()
      ).catch(() => notify("当前浏览器无法进入全屏。"));
      break;
    case "prev":
      stepAlbum(-1);
      break;
    case "next":
      stepAlbum(1);
      break;
    case "genre-prev":
      stepGenre(-1);
      break;
    case "genre-next":
      stepGenre(1);
      break;
    case "genres":
      openPanel("search");
      break;
    case "play-pause":
      playerState.currentTrack ? void player.toggle() : playAlbum();
      break;
    case "stop":
      player.stop();
      break;
    case "scan":
      void scan(true);
      break;
    case "rescan":
      void scan();
      break;
    case "credits-album":
      void queryCredits(true);
      break;
    case "credits-retry":
      void queryCredits(true, true);
      break;
    case "credits-library":
      void queryCredits();
      break;
    case "enrich-library":
      void enrich();
      break;
    case "introduction-album":
      void queryIntroductions(true);
      break;
    case "introductions-library":
      void queryIntroductions();
      break;
    case "edit-genres":
      void editGenres();
      break;
    case "save-online":
      void (async () => {
        try {
          await request("/api/config", {
            musicBrainzContact:
              $<HTMLInputElement>("#metadata-contact").value.trim(),
            onlineEnabled: $<HTMLInputElement>("#online-enabled").checked,
          });
          notify("资料库设置已保存。可以开始补充专辑资料。");
        } catch (error) {
          notify((error as Error).message);
        }
      })();
      break;
    case "save-genres":
      void (async () => {
        const editor = $<HTMLTextAreaElement>("#genre-json");
        try {
          const body = JSON.parse(editor.value);
          await request("/api/genre-rules", body);
          await loadLibrary(true);
          notify("分类规则已保存并应用。");
          if (editor.isConnected && panel === "library") renderLibraryPanel();
        } catch (error) {
          const errorNode = document.querySelector("#genre-error");
          if (editor.isConnected && errorNode)
            errorNode.textContent = (error as Error).message;
          else notify((error as Error).message);
        }
      })();
      break;
    case "demo":
      demo = true;
      closePanel(() => void applyLibrary());
      break;
  }
});
document.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.quality && el.type === "range") {
    renderQuality = normalizeQuality({
      ...renderQuality,
      [el.dataset.quality]: Number(el.value),
    });
    updateQuality();
  }
  if(el.dataset.nativeLight) {
    preferences.lighting=normalizeRowLighting({...preferences.lighting,[el.dataset.nativeLight]:Number(el.value)},DEFAULT_LIGHTING_PRESET);
    scene?.setLightingExperiment(preferences.lighting); savePrefs();
  }
  if(el.id==="native-motion-speed") {
    preferences.motionSpeed=normalizeMusicMotionSpeed(Number(el.value)); setMusicMotionSpeed(preferences.motionSpeed);
    $("#native-motion-value").textContent=`${preferences.motionSpeed.toFixed(2)}×`; savePrefs();
  }
  if (el.id === "bgm-volume") {
    preferences.bgmVolume = Number(el.value) / 100;
    player.setBgmVolume(preferences.bgmVolume);
    savePrefs();
  }
  if (el.id === "sound-volume") {
    preferences.soundVolume = Number(el.value) / 100;
    effects.configure({
      sound: preferences.sound,
      music: false,
      soundVolume: preferences.soundVolume,
      musicVolume: 0,
    });
    savePrefs();
  }
  if (el.id === "album-search") { clearTimeout(searchTimer); searchTimer = setTimeout(renderSearchResults, 120); }
  if (el.id === "volume") {
    preferences.volume = Number(el.value) / 100;
    player.setVolume(preferences.volume);
    savePrefs();
  }
});
document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id === "focus-depth" && scene instanceof NativeArchiveScene) {
    preferences.focusDepth = el.checked;
    scene.setFocusDepth(el.checked); savePrefs();
  }
  if (el.id === "experimental-optics" && experimentalOpticsAvailable && scene instanceof NativeArchiveScene) {
    preferences.experimentalOptics = el.checked;
    scene.setExperimentalOptics(el.checked);
    savePrefs();
  }
  if(el.id==="idle-motion") { preferences.idleMotion=el.checked; if(scene instanceof NativeArchiveScene)scene.setIdleMotion(el.checked); savePrefs(); }
  if(el.id==="native-audio-device") void player.setOutputDevice(el.value);
  if (el.id === "audio-backend") {
    void changeAudioOutput(el.value === "coreaudio" ? "coreaudio" : "browser", playerState.outputDeviceId);
  }
  if (el.id === "audio-device") void changeAudioOutput(playerState.backend, el.value);
  if (el.id === "developer-mode") {
    preferences.developerMode = el.checked;
    lightingControls?.setEnabled(el.checked);
    const debugButton = document.querySelector<HTMLElement>('[data-action="lighting-debug"]');
    if (debugButton) debugButton.hidden = !el.checked;
    savePrefs();
  }
  if (el.id === "developer-motion") {
    preferences.motionDebug = el.checked;
    motionControls?.setEnabled(el.checked);
    const debugButton = document.querySelector<HTMLElement>('[data-action="motion-debug"]');
    if (debugButton) debugButton.hidden = !el.checked;
    savePrefs();
  }
  if (el.id === "music-sort" && ["genre", "artist", "album"].includes(el.value)) {
    if (preferences.sortMode === el.value) return;
    preferences.sortMode = el.value as MusicSortMode;
    savePrefs();
    location.reload();
    return;
  }
  if (el.id === "music-array-mode") {
    preferences.arrayMode = normalizeMusicArrayMode(el.value);
    scene?.setMusicArrayMode(preferences.arrayMode);
    stage.dataset.arrayMode = preferences.arrayMode;
    updateSelection();
    savePrefs();
  }
  if (el.id === "remember-column-position") {
    preferences.rememberColumnPosition = el.checked;
    // Changing this preference never navigates or changes playback. Re-enabling
    // starts with the current album while other columns retain their session memory.
    if (el.checked && records[selected]) columnMemory.set(
      archiveColumns[fileLocation(selected).lane], records[selected].id,
    );
    savePrefs();
  }
  if (el.id === "quality-preset") {
    preferences.quality = el.value as QualityPreset;
    renderQuality = normalizeQuality(qualityPresets[preferences.quality]);
    updateQuality();
  }
  if (el.dataset.quality) {
    renderQuality = normalizeQuality({
      ...renderQuality,
      [el.dataset.quality]:
        el.dataset.quality === "antialias" ? el.value : Number(el.value),
    });
    updateQuality();
  }
  if (el.id === "sound-setting") {
    preferences.sound = el.checked;
    effects.configure({
      sound: el.checked,
      music: false,
      soundVolume: preferences.soundVolume,
      musicVolume: 0,
    });
    savePrefs();
  }
  if (el.id === "song-fade-setting") {
    const mode = normalizeSongTransition(el.value);
    preferences.songTransition = mode;
    el.value = mode;
    player.setSongTransitionMode(mode);
    savePrefs();
  }
  if (el.id === "reduced-motion") {
    preferences.reduced = el.checked;
    transportTitleMotion.setReduced(el.checked);
    if (el.checked) {
      browseTransition.finish();
      detailTransition.finish();
      overviewUI.finish();
    }
    syncSelectionMotion();
    scene?.setReduced(el.checked);
    stage.classList.toggle("reduce-motion", el.checked);
    updateSelection();
    savePrefs();
  }
  if (el.id === "bgm-setting") {
    preferences.bgm = el.checked;
    player.setBgmEnabled(el.checked);
    savePrefs();
  }
});
document.addEventListener("keydown", (e) => {
  if (boot?.active) return;
  if (viewer?.isOpen) return;
  if (e.key === "Escape") {
    handleAndroidBack();
    return;
  }
  if (panel) {
    if (e.key === "Tab") {
      const items = [
        ...document.querySelectorAll<HTMLElement>(
          "#music-panel-root button:not([disabled]), #music-panel-root input, #music-panel-root textarea, #music-panel-root select, #music-panel-root a",
        ),
      ].filter((node) => !node.matches(":disabled") && node.tabIndex >= 0 &&
        !node.closest("[hidden], [inert]") && node.getClientRects().length > 0 &&
        getComputedStyle(node).visibility !== "hidden");
      if (!items.length) return;
      const first = items[0],
        last = items.at(-1)!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    return;
  }
  if (
    (e.target as HTMLElement).matches("[role=tab]") &&
    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
  ) {
    e.preventDefault();
    setTab(
      e.key === "Home"
        ? "tracks"
        : e.key === "End"
          ? "about"
          : activeTab === "tracks"
            ? "about"
            : "tracks",
    );
    $(`#tab-${activeTab}`).focus();
    return;
  }
  if (
    (e.target as HTMLElement).matches(
      "input, textarea, select, [contenteditable=true]",
    )
  )
    return;
  if (e.key === "/") {
    e.preventDefault();
    searchGenre = "";
    openPanel("search");
  }
  if (e.key.toLowerCase() === "v" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    setOverview(!overview);
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    stepGenre(-1);
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    stepGenre(1);
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    stepAlbum(-1);
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    stepAlbum(1);
  }
  if (e.key === "Enter" && !(e.target as HTMLElement).closest("button, a")) {
    e.preventDefault();
    setMode("detail");
  }
  if (e.code === "Space" && !(e.target as HTMLElement).closest("button, a")) {
    e.preventDefault();
    playerState.currentTrack ? void player.toggle() : playAlbum();
  }
});

let lastFrame: number | undefined;
let frameCount = 0, frameHandle = 0, lastSceneDraw = -Infinity;
let frameDisposed = false, frameSuspended = false;
const frameTiming = new MusicFrameTiming();
let textMotionTime = 0, textMotionLastFrame: number | undefined;
function frame(ms: number) {
  frameHandle = 0;
  if (frameDisposed || frameSuspended) return;
  const workStart = performance.now();
  const textDt = textMotionLastFrame === undefined ? 0 : Math.min(.05, Math.max(0, ms - textMotionLastFrame) / 1000);
  textMotionLastFrame = ms;
  if (!document.hidden && scene) {
    frameTiming.begin(ms);
    if (lastFrame === undefined) lastFrame = ms;
    textMotionTime += textDt * (preferences.reduced ? 1 : getMusicMotionSpeed());
    const opening = boot?.update(ms / 1000);
    if (!viewer?.isOpen && opening?.renderScene !== false) {
      const draw = !panel || ms - lastSceneDraw >= 500;
      scene.update(ms / 1000, opening?.cinema, draw);
      if (draw) lastSceneDraw = ms;
    }
    updateOverview();
    if (overviewRevealPending && !overview && !boot?.active &&
      scene.musicOverviewProgress < .02 && scene.musicArchiveReady) {
      overviewRevealPending = false;
      showBrowseSurface();
    }
    viewer?.update(ms / 1000);
    if (!viewer?.isOpen && !boot?.active) presentation.update();
    const phase = presentation.phase;
    if (stage.dataset.presentation !== phase) stage.dataset.presentation = phase;
    const cameraPhase = scene.musicPresentationPhase;
    if (stage.dataset.cameraPhase !== cameraPhase) stage.dataset.cameraPhase = cameraPhase;
    if (presentation.phase === "detail") {
      documentDecryption.update(
        textMotionTime,
        scene.decryptionFrame,
        preferences.reduced,
        !viewer?.isOpen,
      );
      if (pendingDetailFocus && !panel && !viewer?.isOpen) {
        $("#album-detail-content").focus({ preventScroll: true });
        pendingDetailFocus = false;
      }
      if (pendingTrackReveal && !panel && !viewer?.isOpen &&
        $("#music-detail").dataset.transition === "open" &&
        currentAlbum()?.id === pendingTrackReveal.albumId) {
        const content = $("#album-detail-content");
        const trackId = pendingTrackReveal.trackId;
        pendingTrackReveal = undefined;
        const row = Array.from(content.querySelectorAll<HTMLButtonElement>(".track-row"))
          .find((item) => item.dataset.track === trackId);
        if (row) trackFocus.reveal(content, row, preferences.reduced);
      }
    }
    frameCount++;
    if (ms - lastFrame > 1500) {
      $("#runtime-info").textContent =
        `${nativeVulkan ? "VULKAN · GPU INSTANCING" : `${Math.round((frameCount * 1000) / (ms - lastFrame))} FPS`} / ${themeNames[preferences.theme]} / V${appVersion}`;
      // Keep read-only render diagnostics alongside the existing resolution
      // attributes, without adding controls or per-frame DOM work.
      if (!viewer?.isOpen) {
        const { drawCalls, triangles, selectionLight, arrayMode, visibleAlbumCells, uniqueAlbumCells, covers, graphics } = scene.getStats();
        $("#three-scene").dataset.renderStats = JSON.stringify({
          drawCalls,
          triangles,
          arrayMode, visibleAlbumCells, uniqueAlbumCells, covers, graphics,
        });
        $("#three-scene").dataset.selectionLight =
          JSON.stringify(selectionLight);
      }
      $("#three-scene").dataset.frameTiming = JSON.stringify(frameTiming.snapshot());
      frameCount = 0;
      lastFrame = ms;
    }
    frameTiming.end(performance.now() - workStart);
  } else {
    resetFrameTiming();
  }
  frameHandle = requestAnimationFrame(frame);
}
function resetFrameTiming() {
  frameCount = 0;
  lastFrame = undefined;
  textMotionLastFrame = undefined;
  frameTiming.reset();
}
function suspendPage() {
  effects.suspend();
  frameSuspended = true;
  cancelAnimationFrame(frameHandle);
  frameHandle = 0;
  clearTimeout(pollTimer);
  resetFrameTiming();
}
function resumePage() {
  effects.resume();
  if (frameDisposed || document.hidden || (ready && document.querySelector("#music-loading"))) return;
  frameSuspended = false;
  resetFrameTiming();
  if (ready && !frameHandle) frameHandle = requestAnimationFrame(frame);
  if (ready) void loadLibrary();
}
function disposePage() {
  if (frameDisposed) return;
  frameDisposed = true;
  suspendPage();
  clearTimeout(toastTimer);
  boot?.dispose();
  nowPlayingTransition.dispose();
  cancelAnimationFrame(fitFrame);
  overviewUI.dispose();
  player.dispose();
  effects.dispose();
  trackFocus.cancel();
  scene?.dispose();
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) suspendPage(); else resumePage();
});
window.addEventListener("pagehide", (event) => {
  if (event.persisted) suspendPage(); else disposePage();
});
window.addEventListener("pageshow", (event) => { if (event.persisted) resumePage(); });

async function start() {
  // This local application owns its live index. An old archive PWA must not serve stale UI.
  if (false && "serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((r) => r.unregister()));
  }
  try {
    await loadLibrary(true);
    if (frameDisposed) return;
    fit();
    scene = await createArchiveScene($("#three-scene"));
    if (frameDisposed) { scene.dispose(); return; }
    scene.setMusicArrayMode(preferences.arrayMode);
    stage.dataset.arrayMode = preferences.arrayMode;
    // Keep a direct visual comparison URL without adding another user setting.
    if (lightingLab || new URLSearchParams(location.search).get("lighting") !== "baseline")
      scene.enableSelectionLighting();
    scene.setLightingExperiment(normalizeRowLighting(preferences.lighting || {}, DEFAULT_LIGHTING_PRESET));
    if (lightingLab && !nativeVulkan) {
      const devPanels = document.createElement("div");
      devPanels.className = "music-dev-panels";
      stage.append(devPanels);
      const closeDebugPanel = (key: "developerMode" | "motionDebug") => {
        preferences[key] = false;
        savePrefs();
        if (panel === "settings") renderSettingsPanel();
        else document.querySelector<HTMLButtonElement>('[data-action="settings"]')?.focus({ preventScroll: true });
      };
      motionControls = setupMotionLab(devPanels, {
        enabled: preferences.motionDebug,
        onChange: (speed) => { preferences.motionSpeed = speed; savePrefs(); },
        onClose: () => closeDebugPanel("motionDebug"),
      });
      lightingControls = setupLightingLab(devPanels, {
        setExperiment: (settings) => scene?.setLightingExperiment(settings),
        enabled: preferences.developerMode,
        initial: preferences.lighting,
        onChange: (settings) => {
          preferences.lighting = settings;
          savePrefs();
        },
        onClose: () => closeDebugPanel("developerMode"),
      });
    }
    void document.fonts.load("400 20px MiSans").catch(() => {});
    void document.fonts.load("600 20px MiSans").catch(() => {});
    await scene.load(undefined, selected);
    if (frameDisposed) return;
    $("#music-loading small").textContent = "正在准备渲染器与专辑封面…";
    $(nativeVulkan ? "#three-scene" : "#three-scene canvas").setAttribute(
      "aria-label",
      `三维专辑阵列，左右切${sortLabel.column}，上下切专辑`,
    );
    stage.classList.toggle("reduce-motion", preferences.reduced);
    scene.setTheme(preferences.theme);
    scene.setQuality(renderQuality);
    scene.setReduced(preferences.reduced);
    if(scene instanceof NativeArchiveScene) {
      scene.setIdleMotion(preferences.idleMotion);
      scene.setFocusDepth(preferences.focusDepth !== false);
      if (experimentalOpticsAvailable) scene.setExperimentalOptics(preferences.experimentalOptics === true);
    }
    await scene.prepareMusicRenderer();
    if (frameDisposed) return;
    // Browser playback does not need a Swift compiler at startup. A saved
    // native output is restored after graphics preparation; otherwise discover
    // native devices only when the user opens the output settings.
    if (preferences.audioBackend === "coreaudio") {
      $("#music-loading small").textContent = "正在连接已选择的音频设备…";
      await refreshAudioOutputs(true);
    }
    if (frameDisposed) return;
    ready = true;
    if (nativeLibraryPending) { nativeLibraryPending = false; await loadLibrary(true); }
    if (frameDisposed) return;
    sceneCanvasLifecycle();
    restoreAndroidSelection();
    $<HTMLButtonElement>('[data-action="overview"]').disabled = false;
    scene.onSelect = (index, cell) => {
      if (!boot?.active && presentation.phase === "archive" && !panel) {
        select(index, cell ? { cell } : undefined);
        if (overview) setOverview(false);
      }
    };
    scene.onNavigate = (axis, direction) => {
      if (!boot?.active && presentation.phase === "archive" && !panel)
        axis === "lane" ? stepGenre(direction) : stepAlbum(direction);
    };
    mountMusicWheelNavigation(stage, {
      enabled: () => ready && !boot?.active && presentation.phase === "archive" && !panel &&
        columnFiles(fileLocation(navigationSelection()).lane).length > 1,
      navigate: stepAlbum,
      context: () => fileLocation(navigationSelection()).lane,
    });
    $("#music-loading").remove();
    updateSelection();
    if (!preferences.reduced && new URLSearchParams(location.search).get("intro") !== "0") {
      boot?.start(performance.now() / 1000);
    } else {
      scene.showMusicArchiveImmediately(performance.now() / 1000);
      effects.setScene("archive");
      if (albums.length) showBrowseSurface();
      else browseTransition.hide(true);
      $("#music-browse").inert = !albums.length;
      $("#music-browse").setAttribute("aria-hidden", String(!albums.length));
    }
    syncSelectionMotion();
    stage.classList.add("theme-motion-ready");
    if (!document.hidden && !frameDisposed) {
      frameSuspended = false;
      resetFrameTiming();
      frameHandle = requestAnimationFrame(frame);
      // Poll only after data, geometry and renderer preparation agree. During
      // the opening loadLibrary() defers updates until its handoff completes.
      void loadLibrary();
    }
  } catch (error) {
    console.error(error);
    if (frameDisposed) return;
    $("#music-loading").innerHTML =
      `<strong>三维资源未能加载</strong><small>${esc((error as Error).message)}。请重试打开界面。</small><button data-action="reload-interface">重新载入</button>`;
  }
}
void start();
Object.assign(window, {
  rhineDroid: {
    get library() {
      return library;
    },
    get selectedAlbum() {
      return currentAlbum();
    },
    get player() {
      return player.state;
    },
    stats: () => scene?.getStats(),
    get presentation() {
      return { phase: presentation.phase, cameraPhase: scene?.musicPresentationPhase,
        pendingIndex: presentation.pendingSelection?.index,
        menuVisible: !$("#music-detail").hidden,
        cameraReady: scene?.musicPresentationReady,
        archiveReady: scene?.musicArchiveReady };
    },
  },
});


function canHandleAndroidBack() {
  if (!ready || document.querySelector("#music-loading")) return false;
  return !!boot?.active || !!panel || nowPlayingOpen || overview || presentation.phase !== "archive";
}
function handleAndroidBack() {
  if (!ready || document.querySelector("#music-loading")) return false;
  if (boot?.active) { boot.skip(); return true; }
  if (panel) { closePanel(); return true; }
  if (nowPlayingOpen) { setNowPlaying(false); return true; }
  if (overview) { setOverview(false); return true; }
  if (presentation.phase !== "archive") { setMode("archive"); return true; }
  return false;
}
stage.addEventListener("rhine-scene-error", (event) => {
  if (!ready || document.querySelector("#music-loading")) return;
  suspendPage();
  const error = document.createElement("div");
  error.id = "music-loading";
  error.innerHTML = `<strong>Vulkan 场景操作失败</strong><small>${esc((event as CustomEvent).detail)}</small><button data-action="reload-interface">重新载入</button>`;
  stage.append(error);
});
function sceneCanvasLifecycle() {
  if (nativeVulkan) return;
  const canvas = $("#three-scene canvas");
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    suspendPage();
    const error = document.createElement("div");
    error.id = "music-loading";
    error.innerHTML = '<strong>图形资源已释放</strong><small>重新载入以恢复音乐档案。</small><button data-action="reload-interface">重新载入</button>';
    stage.append(error);
  });
  canvas.addEventListener("webglcontextrestored", () => location.reload());
}
function restoreAndroidSelection() {
  const saved = read<{ albumId?: string }>("rhine-android-session", {});
  const index = records.findIndex((record) => record.id === saved.albumId);
  if (index >= 0) select(index, undefined, false, "archive");
}
let lastAndroidState = "";
let lastSavedAlbum: string | undefined;
const publishAndroidState = () => {
  const state = JSON.stringify({ type: "ui-state", canGoBack: canHandleAndroidBack(), theme: preferences.theme });
  if (state !== lastAndroidState) {
    lastAndroidState = state;
    const host = (window as unknown as { RhineHost?: { postMessage(message: string): void } }).RhineHost;
    host?.postMessage(state);
  }
  const album = currentAlbum();
  if (ready && album && album.id !== lastSavedAlbum) {
    lastSavedAlbum = album.id;
    save("rhine-android-session", { albumId: album.id });
  }
};
new MutationObserver(publishAndroidState).observe(stage, {
  attributes: true, attributeFilter: ["data-mode", "data-theme", "data-overview", "data-presentation", "data-music-boot"],
  childList: true,
});
Object.assign(window, { rhineAndroid: {
  back: handleAndroidBack,
  canGoBack: canHandleAndroidBack,
  suspend: suspendPage,
  resume: resumePage,
} });
publishAndroidState();

let nativeLibraryRefresh = Promise.resolve();
window.addEventListener("rhine-native", ((event: CustomEvent) => {
  const value = event.detail;
  if (value?.type === "error") notify(value.error);
  if(value?.type==="metadata-updated") { if(ready) nativeLibraryRefresh=nativeLibraryRefresh.then(()=>loadLibrary(true)).catch(error=>notify(error.message)); return; }
  if (value?.type !== "library-status") return;
  library.scan.running = value.running;
  library.scan.error = value.error || undefined;
  updateStatus(); updateScanStatus();
  if (value.running) {
    const status = document.querySelector("#scan-status");
    if (status) status.textContent = `正在扫描音乐 · ${value.count || 0} 首…`;
  } else if (value.error) notify(value.error);
  else if (!ready) nativeLibraryPending = true;
  else nativeLibraryRefresh = nativeLibraryRefresh.then(() => loadLibrary(true)).catch(error => notify(error.message));
}) as EventListener);
if (nativeAvailable()) void nativeCommand("ready", { volume: preferences.volume, songTransition:preferences.songTransition, bgm:preferences.bgm, bgmVolume:preferences.bgmVolume }).catch(error => notify(error.message));
