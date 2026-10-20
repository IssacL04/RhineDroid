import type { MusicTrack } from "./music-types";
import { normalizeSongTransition, type SongTransitionMode } from "./music-song-transition.ts";
import { AudioClockSuspended, BrowserGaplessPlayer } from "./music-browser-gapless.ts";

export interface AudioOutputDevice { id: string; name: string }
export interface AudioCapabilities {
  decoderAvailable: boolean;
  nativeAvailable: boolean;
  devices: AudioOutputDevice[];
  decoder?: string | null;
  decoderError?: string | null;
  nativeError?: string | null;
}
interface NativeState {
  trackId: string; playing: boolean; currentTime: number; duration: number;
  deviceId: string; endedSerial: number; error?: string;
  nextTrackId?: string; boundarySerial?: number;
}

export interface MusicPlayerState {
  transport: "idle" | "loading" | "playing" | "paused" | "error";
  currentTrack: MusicTrack | null;
  queue: readonly MusicTrack[];
  currentIndex: number;
  playing: boolean;
  loading: boolean;
  duration: number;
  currentTime: number;
  volume: number;
  songTransitionMode: SongTransitionMode;
  /** Legacy read-only projection; new settings use songTransitionMode. */
  songFadeEnabled: boolean;
  bgmVolume: number;
  bgmEnabled: boolean;
  bgmPlaying: boolean;
  error: string | null;
  bgmError: string | null;
  backend: "browser" | "coreaudio";
  outputDeviceId: string;
  outputDevices: AudioOutputDevice[];
  decoderAvailable: boolean;
  nativeAvailable: boolean;
  outputError: string | null;
  transitionWarning: string | null;
}

type Listener = (state: MusicPlayerState) => void;
type Transport = MusicPlayerState["transport"];
type Fade = { timer: ReturnType<typeof setTimeout>; finish: () => void };

const SONG_FADE_MS = 450;
const unit = (value: number) => Math.max(0, Math.min(1, value));
const seconds = (value: number) =>
  Number.isFinite(value) && value > 0 ? value : 0;
const isDsdTrack = (track: MusicTrack) =>
  /^(DSD|DSF|DFF)$/i.test(track.format) || /\.(dsf|dff)$/i.test(track.relativePath);
const uniqueTracks = (tracks: readonly MusicTrack[]): MusicTrack[] => {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    if (seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  });
};

/** Music transport is independent from TerminalAudio and the Three.js scene lifecycle. */
export class MusicPlayer {
  private value: Omit<MusicPlayerState, "transport">;
  private listeners = new Set<Listener>();
  private song?: HTMLAudioElement;
  private songTrackId?: string;
  private songGain = 1;
  private songFade?: Fade & { target: number };
  private readonly bgm: HTMLAudioElement;
  private transport: Transport = "idle";
  private operation = 0;
  private bgmOperation = 0;
  private bgmTarget = 0;
  private bgmTask: Promise<void> = Promise.resolve();
  private fade?: Fade;
  private gestureReceived = false;
  private disposed = false;
  private pendingSeek: number | null = null;
  private preparation?: AbortController;
  private nativePoll?: ReturnType<typeof setTimeout>;
  private nativeEndedSerial = 0;
  private outputOperation = 0;
  private nativePollEpoch = 0;
  private gapless?: BrowserGaplessPlayer;
  private gaplessFallback = false;
  private nativePreparedId?: string;
  private nativeHandoffId?: string;
  private nativePrepareGeneration = 0;

  constructor(
    options: {
      volume?: number;
      songTransitionMode?: SongTransitionMode;
      songFadeEnabled?: boolean;
      bgmVolume?: number;
      bgmEnabled?: boolean;
    } = {},
  ) {
    const transitionMode = normalizeSongTransition(options.songTransitionMode, options.songFadeEnabled);
    this.value = {
      currentTrack: null,
      queue: [],
      currentIndex: -1,
      playing: false,
      loading: false,
      duration: 0,
      currentTime: 0,
      volume: Number.isFinite(options.volume) ? unit(options.volume!) : 0.7,
      songTransitionMode: transitionMode,
      songFadeEnabled: transitionMode !== "gapless",
      bgmVolume: Number.isFinite(options.bgmVolume)
        ? unit(options.bgmVolume!)
        : 0.18,
      bgmEnabled: options.bgmEnabled ?? true,
      bgmPlaying: false,
      error: null,
      bgmError: null,
      backend: "browser",
      outputDeviceId: "default",
      outputDevices: [{ id: "default", name: "系统默认输出" }],
      decoderAvailable: false,
      nativeAvailable: false,
      outputError: null,
      transitionWarning: null,
    };
    this.bgm = new Audio("/audio/atmosphere.ogg");
    this.bgm.loop = true;
    this.bgm.preload = "none";
    this.bgm.volume = 0;
    this.bgm.addEventListener("error", this.onBgmError);
    document.addEventListener("pointerdown", this.onGesture, { capture: true });
    document.addEventListener("keydown", this.onGesture, { capture: true });
    // Intentionally no visibilitychange handler: music must continue in the background.
  }

  get state(): MusicPlayerState {
    return { ...this.value, transport: this.transport, queue: [...this.value.queue] };
  }

  subscribe(listener: Listener): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async refreshOutputs(): Promise<AudioCapabilities> {
    const response = await fetch("/api/audio/capabilities");
    const capabilities = await response.json() as AudioCapabilities & { error?: string };
    if (!response.ok) throw new Error(capabilities.error || "无法读取音频输出");
    if (!this.disposed) {
      this.value.decoderAvailable = capabilities.decoderAvailable;
      this.value.nativeAvailable = capabilities.nativeAvailable;
      this.value.outputDevices = capabilities.devices;
      this.value.outputError = capabilities.nativeError ?? capabilities.decoderError ?? null;
      this.emit();
    }
    return capabilities;
  }

  async setBackend(backend: "browser" | "coreaudio", deviceId = "default"): Promise<void> {
    if (this.disposed) return;
    const outputRequest = ++this.outputOperation;
    if (backend === "coreaudio") {
      const capabilities = await this.refreshOutputs();
      if (outputRequest !== this.outputOperation || this.disposed) return;
      if (!capabilities.nativeAvailable) throw new Error(capabilities.nativeError || "CoreAudio 输出不可用，请检查 FFmpeg 和 Apple Command Line Tools");
    }
    if (this.value.backend === "coreaudio") await this.cancelNativeNext();
    if (outputRequest !== this.outputOperation || this.disposed) return;
    void this.gapless?.trackId;
    const current = this.value.currentTrack;
    const position = this.gapless?.trackId ? this.gapless.position : this.value.currentTime;
    const resume = this.expectsSong();
    ++this.operation;
    this.preparation?.abort();
    this.gapless?.stop(); this.cancelNativeNext();
    this.gaplessFallback = false; this.value.transitionWarning = null;
    this.releaseSong();
    this.value.playing = false; this.value.loading = false; this.value.error = null;
    this.transport = resume ? "loading" : current ? "paused" : "idle";
    if (this.value.backend === "coreaudio") await this.nativeCommand({ action: "stop" });
    if (outputRequest !== this.outputOperation || this.disposed) return;
    this.value.backend = backend;
    this.value.outputDeviceId = deviceId;
    this.value.outputError = null;
    if (backend === "coreaudio") {
      try { await this.nativeCommand({ action: "device", deviceId }); }
      catch (error) {
        if (outputRequest !== this.outputOperation || this.disposed) return;
        this.value.backend = "browser";
        this.transport = current ? "paused" : "idle";
        this.value.outputError = error instanceof Error ? error.message : "输出设备不可用";
        this.emit(); throw error;
      }
      if (outputRequest !== this.outputOperation || this.disposed) return;
      this.startNativePoll();
    } else this.stopNativePoll();
    this.value.currentTime = position;
    this.pendingSeek = current ? position : null;
    this.emit();
    if (resume && current) {
      await this.play(current.id);
      if (outputRequest === this.outputOperation) this.seek(position);
    }
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    if (this.disposed) return;
    const outputRequest = ++this.outputOperation;
    if (this.value.backend !== "coreaudio") { this.value.outputDeviceId = deviceId; this.emit(); return; }
    try {
      await this.cancelNativeNext();
      if (outputRequest !== this.outputOperation || this.disposed) return;
      const state = await this.nativeCommand({ action: "device", deviceId });
      if (outputRequest !== this.outputOperation || this.disposed) return;
      this.adoptNativePosition(state);
      this.value.outputDeviceId = state.deviceId;
      this.value.outputError = null;
      this.emit();
      this.prepareSuccessor();
    } catch (error) {
      if (outputRequest !== this.outputOperation || this.disposed) return;
      this.value.outputError = error instanceof Error ? error.message : "输出设备不可用";
      this.fail(this.value.outputError);
      throw error;
    }
  }

  setQueue(tracks: readonly MusicTrack[]): void {
    if (this.disposed) return;
    void this.gapless?.trackId;
    const queue = uniqueTracks(tracks);
    this.value.queue = queue;
    const apply = () => {
      const id = this.value.currentTrack?.id;
      const index = queue.findIndex((track) => track.id === id);
      if (id && index === -1) {
        this.stop(); this.value.currentTrack = null; this.value.duration = 0;
      } else if (index !== -1) this.value.currentTrack = queue[index];
      this.value.currentIndex = index; this.prepareSuccessor(); this.emit();
    };
    if (this.value.backend === "coreaudio" && this.nativePreparedId) {
      const operation = this.operation;
      void this.cancelNativeNext().then(() => {
        if (!this.disposed && operation === this.operation && this.value.queue === queue) apply();
      });
    } else apply();
  }

  async play(id: string, tracks?: readonly MusicTrack[]): Promise<void> {
    if (this.disposed) return;
    const queue = tracks ? uniqueTracks(tracks) : this.value.queue;
    if (tracks && (queue.length !== this.value.queue.length || queue.some((track, i) => track.id !== this.value.queue[i]?.id))) {
      this.gaplessFallback = false; this.value.transitionWarning = null;
    }
    const index = queue.findIndex((track) => track.id === id);
    if (index === -1) {
      this.value.error = "这首歌曲已不在播放队列中，请重新选择。";
      this.emit();
      return;
    }
    const track = queue[index];
    if (this.value.backend === "coreaudio") return this.playNative(track, queue, index);
    if (this.value.songTransitionMode === "gapless" && !this.gaplessFallback)
      return this.playGapless(track, queue, index);
    this.gapless?.stop();
    this.preparation?.abort();
    // Updating the queue in a play request keeps cross-album switches in the same fade.
    this.value.queue = queue;
    const request = ++this.operation;
    const retainedSeek = this.value.currentTrack?.id === id ? this.pendingSeek : null;
    this.cancelSongFade();
    const resume =
      this.songTrackId === id && this.song && !this.song.ended
        ? this.song
        : undefined;
    this.value.currentTrack = track;
    this.value.currentIndex = index;
    this.value.error = null;
    this.value.loading = true;
    this.transport = "loading";
    this.value.playing = !!resume && !resume.paused;
    this.value.currentTime = resume
      ? this.pendingSeek ?? seconds(resume.currentTime)
      : 0;
    this.value.duration =
      (resume ? seconds(resume.duration) : 0) || seconds(track.duration);
    if (!resume) this.pendingSeek = retainedSeek;
    const unsupported = this.unsupported(track);
    if (unsupported) {
      this.fail(unsupported);
      return;
    }
    this.emit();
    if (request !== this.operation || this.disposed) return;

    if (!resume) {
      const outgoing = this.song;
      if (
        outgoing &&
        !outgoing.paused &&
        !outgoing.ended &&
        this.value.songTransitionMode !== "gapless"
      ) {
        await this.fadeSong(outgoing, 0);
        if (request !== this.operation || this.disposed) return;
      }
      // Release the outgoing source before the next one can start: songs never overlap.
      this.releaseSong();
      this.pendingSeek = retainedSeek;
    }
    let audioUrl = track.audioUrl;
    // Older indexes marked DSD undecodable. Always prepare a PCM source for it,
    // including when that cached entry predates decodedAudioUrl.
    const dsd = isDsdTrack(track);
    const decodedAudioUrl = track.decodedAudioUrl || (dsd ? `/api/decoded-audio/${encodeURIComponent(track.id)}` : undefined);
    if (!resume && decodedAudioUrl && (dsd || track.localDecodable !== false)) {
      const controller = new AbortController();
      this.preparation = controller;
      try {
        const response = await fetch(`/api/audio/prepare/${encodeURIComponent(track.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: controller.signal });
        const result = await response.json() as { audioUrl?: string; duration?: number; error?: string };
        if (request !== this.operation || this.disposed || controller.signal.aborted) return;
        if (!response.ok) {
          if (response.status !== 503 || dsd || !track.browserPlayable) throw new Error(result.error || "音频解码失败");
        } else {
          audioUrl = result.audioUrl || decodedAudioUrl;
          this.value.duration = seconds(result.duration || 0) || this.value.duration;
        }
      } catch (error) {
        if (request !== this.operation || this.disposed || controller.signal.aborted) return;
        this.fail(error instanceof Error ? error.message : "本地解码失败"); return;
      } finally { if (this.preparation === controller) this.preparation = undefined; }
      if (request !== this.operation || this.disposed) return;
    }
    const audio = this.song ?? this.createSong(track, audioUrl);

    // A shared transition promise keeps rapid BGM toggles from bypassing this silence gate.
    await this.reconcileBgm();
    if (request !== this.operation || this.disposed || this.song !== audio)
      return;
    try {
      await audio.play();
      if (request !== this.operation || this.disposed || this.song !== audio) {
        if (this.song !== audio || !this.expectsSong()) audio.pause();
        return;
      }
      if (!audio.paused) {
        this.transport = "playing";
        this.value.playing = true;
        this.value.loading = false;
        this.emit();
        if (request !== this.operation || this.disposed || this.song !== audio)
          return;
        if (this.value.songTransitionMode === "fade-in-out") await this.fadeSong(audio, 1);
        else this.setSongGain(1);
      }
    } catch (error) {
      if (request !== this.operation || this.disposed || this.song !== audio)
        return;
      this.fail(this.playbackError(track, error));
    }
  }

  async toggle(): Promise<void> {
    if (this.disposed) return;
    void this.gapless?.trackId;
    if (this.value.backend === "coreaudio") {
      if (this.expectsSong()) {
        const request = ++this.operation;
        const cancelled = this.cancelNativeNext();
        this.transport = "paused"; this.value.playing = false; this.value.loading = false;
        this.emit();
        try {
          await cancelled;
          if (request !== this.operation || this.disposed) return;
          const state = await this.nativeCommand({ action: "pause" });
          if (request !== this.operation || this.disposed) return;
          this.adoptNativePosition(state); this.emit();
        } catch (error) { if (request === this.operation && !this.disposed) this.fail(error instanceof Error ? error.message : "原生输出暂停失败"); }
      } else { const track = this.value.currentTrack ?? this.value.queue[0]; if (track) await this.play(track.id); }
      return;
    }
    if (this.transport === "loading" || this.transport === "playing") {
      ++this.operation;
      this.preparation?.abort();
      if (this.gapless?.trackId) this.value.currentTime = this.gapless.pause();
      this.cancelSongFade();
      this.transport = "paused";
      this.song?.pause();
      if (this.songTrackId !== this.value.currentTrack?.id) this.releaseSong();
      else this.setSongGain(1);
      this.value.playing = false;
      this.value.loading = false;
      this.emit();
      await this.reconcileBgm();
      return;
    }
    const track = this.value.currentTrack ?? this.value.queue[0];
    if (track) await this.play(track.id);
  }

  async next(): Promise<void> {
    if (this.disposed) return;
    if (this.value.backend === "coreaudio") {
      const operation = this.operation; await this.cancelNativeNext();
      if (operation !== this.operation || this.disposed) return;
    }
    void this.gapless?.trackId;
    const track = this.value.queue[this.value.currentIndex + 1];
    if (track) await this.play(track.id);
    else this.stop();
  }

  async previous(): Promise<void> {
    if (this.disposed) return;
    if (this.value.backend === "coreaudio") {
      const operation = this.operation; await this.cancelNativeNext();
      if (operation !== this.operation || this.disposed) return;
    }
    void this.gapless?.trackId;
    if (this.value.currentTime > 3 && (this.song || this.gapless?.trackId || this.value.backend === "coreaudio")) {
      this.seek(0);
      return;
    }
    const track = this.value.queue[Math.max(0, this.value.currentIndex - 1)];
    if (track) {
      if (track.id === this.value.currentTrack?.id) this.seek(0);
      await this.play(track.id);
    }
  }

  seek(position: number): void {
    if (this.disposed || !Number.isFinite(position)) return;
    if (this.value.backend === "coreaudio") {
      if (this.transport === "loading") { this.pendingSeek = Math.max(0, position); this.value.currentTime = this.pendingSeek; this.emit(); return; }
      const target = Math.max(0, this.value.duration > 0 ? Math.min(this.value.duration, position) : position);
      this.value.currentTime = target; this.emit();
      const operation = ++this.operation;
      const cancelled = this.cancelNativeNext();
      void cancelled.then(() => {
        if (operation !== this.operation || this.disposed) return;
        return this.nativeCommand({ action: "seek", position: target });
      }).then(state => {
        if (state && operation === this.operation) { this.adoptNativePosition(state); this.emit(); this.prepareSuccessor(); }
      }).catch((error) => { if (operation === this.operation && !this.disposed) this.fail(error.message); });
      return;
    }
    if (this.gapless?.trackId) {
      this.gapless.seek(position); this.prepareSuccessor(); return;
    }
    if (!this.song && this.transport === "loading") { this.pendingSeek = Math.max(0, position); this.value.currentTime = this.pendingSeek; this.emit(); return; }
    if (
      this.disposed ||
      !this.song ||
      this.songTrackId !== this.value.currentTrack?.id ||
      !Number.isFinite(position)
    )
      return;
    const duration = seconds(this.song.duration) || this.value.duration;
    const target = Math.max(
      0,
      duration > 0 ? Math.min(duration, position) : position,
    );
    this.pendingSeek = target;
    if (this.song.readyState >= 1) this.applySeek(this.song);
    this.value.currentTime = target;
    this.emit();
  }

  stop(): void {
    if (this.disposed) return;
    ++this.operation;
    this.preparation?.abort();
    this.gapless?.stop(); void this.cancelNativeNext(false);
    this.gaplessFallback = false; this.value.transitionWarning = null;
    if (this.value.backend === "coreaudio") void this.nativeCommand({ action: "stop" }).catch(() => {});
    this.transport = "idle";
    this.releaseSong();
    this.value.playing = false;
    this.value.loading = false;
    this.value.currentTime = 0;
    this.value.error = null;
    this.emit();
    void this.reconcileBgm();
  }

  setVolume(volume: number): void {
    if (this.disposed || !Number.isFinite(volume)) return;
    this.value.volume = unit(volume);
    this.gapless?.volume(this.value.volume);
    if (this.value.backend === "coreaudio") void this.nativeCommand({ action: "volume", volume: this.value.volume }).catch((error) => { this.value.outputError = error.message; this.emit(); });
    this.setSongGain(this.songGain);
    this.emit();
  }

  setSongTransitionMode(mode: SongTransitionMode): void {
    if (this.disposed) return;
    const transitionMode = normalizeSongTransition(mode);
    const previous = this.value.songTransitionMode;
    const position = this.gapless?.trackId ? this.gapless.position : this.value.currentTime;
    const resume = this.expectsSong();
    this.value.songTransitionMode = transitionMode;
    this.value.songFadeEnabled = transitionMode !== "gapless";
    this.gaplessFallback = false; this.value.transitionWarning = null;
    if (this.value.backend === "coreaudio") {
      const output = this.outputOperation;
      const operation = this.operation;
      void this.cancelNativeNext().then(() => {
        if (this.disposed || this.value.backend !== "coreaudio" || output !== this.outputOperation || operation !== this.operation || this.value.songTransitionMode !== transitionMode) return;
        return this.nativeCommand({ action: "transition", transitionMode });
      }).then(state => {
        if (state && operation === this.operation) { this.adoptNativePosition(state); this.emit(); this.prepareSuccessor(); }
      }).catch((error) => {
        if (this.disposed || this.value.backend !== "coreaudio" || output !== this.outputOperation) return;
        this.value.outputError = error instanceof Error ? error.message : "无法更新歌曲衔接方式";
        this.emit();
      });
    } else if (previous !== transitionMode && (previous === "gapless" || transitionMode === "gapless")) {
      // A transport change retains the actual position and paused state. It
      // cannot leave a previously scheduled next source alive in the old engine.
      ++this.operation; this.preparation?.abort();
      this.gapless?.stop(); this.releaseSong();
      this.value.currentTime = position; this.pendingSeek = position;
      this.value.playing = false; this.value.loading = false;
      this.transport = this.value.currentTrack ? "paused" : "idle";
      if (resume && this.value.currentTrack) void this.play(this.value.currentTrack.id);
    }
    if ((this.songFade?.target === 0 && transitionMode === "gapless") ||
      (this.songFade?.target === 1 && transitionMode !== "fade-in-out")) {
      this.cancelSongFade();
      // Finishing an incoming fade must restore full user volume. An outgoing
      // switch retains source ownership until its awaiting operation resumes.
      if (this.songTrackId === this.value.currentTrack?.id) this.setSongGain(1);
    }
    this.emit();
  }

  /** Compatibility for callers with an older saved boolean. */
  setSongFadeEnabled(enabled: boolean): void {
    this.setSongTransitionMode(enabled ? "fade-in-out" : "gapless");
  }

  setBgmVolume(volume: number): void {
    if (this.disposed || !Number.isFinite(volume)) return;
    this.value.bgmVolume = unit(volume);
    this.emit();
    void this.reconcileBgm();
  }

  setBgmEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.value.bgmEnabled = enabled;
    this.value.bgmError = null;
    this.emit();
    void this.reconcileBgm();
  }

  dispose(): void {
    if (this.disposed) return;
    // pagehide may unload this document before a normal fetch reaches the local
    // service. This tiny request must survive unload; hidden tabs still keep
    // playing because visibilitychange never calls dispose().
    if (this.value.backend === "coreaudio") void this.nativeCommand({ action: "stop" }, true).catch(() => {});
    this.preparation?.abort();
    this.gapless?.dispose(); this.gapless = undefined;
    ++this.nativePrepareGeneration;
    this.stopNativePoll();
    this.disposed = true;
    ++this.operation;
    ++this.bgmOperation;
    this.cancelFade();
    this.releaseSong();
    this.bgm.pause();
    this.bgm.removeEventListener("error", this.onBgmError);
    this.bgm.removeAttribute("src");
    this.bgm.load();
    document.removeEventListener("pointerdown", this.onGesture, {
      capture: true,
    });
    document.removeEventListener("keydown", this.onGesture, { capture: true });
    this.listeners.clear();
  }

  private createSong(track: MusicTrack, source = track.audioUrl): HTMLAudioElement {
    const audio = new Audio();
    this.song = audio;
    this.songTrackId = track.id;
    this.songGain = this.value.songTransitionMode === "fade-in-out" ? 0 : 1;
    audio.preload = "metadata";
    this.setSongGain(this.songGain);
    const active = () =>
      !this.disposed &&
      this.song === audio &&
      this.value.currentTrack?.id === track.id;
    audio.addEventListener("loadedmetadata", () => {
      if (!active()) return;
      this.value.duration = seconds(audio.duration) || seconds(track.duration);
      this.applySeek(audio);
      this.emit();
    });
    audio.addEventListener("durationchange", () => {
      if (!active()) return;
      this.value.duration = seconds(audio.duration) || seconds(track.duration);
      this.emit();
    });
    audio.addEventListener("timeupdate", () => {
      if (!active() || this.pendingSeek !== null) return;
      this.value.currentTime = seconds(audio.currentTime);
      this.emit();
    });
    audio.addEventListener("playing", () => {
      if (!active() || audio.paused) return;
      if (this.transport !== "loading" && this.transport !== "playing") {
        audio.pause();
        return;
      }
      this.transport = "playing";
      this.value.playing = true;
      this.value.loading = false;
      this.emit();
    });
    audio.addEventListener("waiting", () => {
      if (!active() || this.transport !== "playing") return;
      this.value.loading = true;
      this.emit();
    });
    audio.addEventListener("pause", () => {
      if (!active() && this.song === audio && audio.paused) {
        this.cancelSongFade();
        return;
      }
      if (
        !active() ||
        this.transport !== "playing" ||
        audio.ended ||
        !audio.paused
      )
        return;
      ++this.operation;
      this.cancelSongFade();
      this.setSongGain(1);
      this.transport = "paused";
      this.value.playing = false;
      this.value.loading = false;
      this.emit();
    });
    audio.addEventListener("ended", () => {
      if (!active() && this.song === audio && audio.ended) {
        // The outgoing song can finish naturally during its fade-out.
        this.cancelSongFade();
        return;
      }
      if (!active() || this.transport !== "playing") return;
      this.cancelSongFade();
      this.value.playing = false;
      this.value.loading = false;
      this.value.currentTime = this.value.duration;
      const next = this.value.queue[this.value.currentIndex + 1];
      if (next) {
        // No idle intermediate state, so BGM never appears between songs.
        void this.play(next.id);
      } else {
        ++this.operation;
        this.transport = "idle";
        this.emit();
        void this.reconcileBgm();
      }
    });
    audio.addEventListener("error", () => {
      if (active()) this.fail(this.playbackError(track, audio.error));
      else if (this.song === audio) this.cancelSongFade();
    });
    audio.src = source || `/api/audio/${encodeURIComponent(track.id)}`;
    return audio;
  }

  private applySeek(audio: HTMLAudioElement): void {
    if (this.pendingSeek === null || audio.readyState < 1) return;
    const target = Math.max(
      0,
      seconds(audio.duration) > 0
        ? Math.min(audio.duration, this.pendingSeek)
        : this.pendingSeek,
    );
    try {
      audio.currentTime = target;
      this.pendingSeek = null;
      this.value.currentTime = target;
    } catch {
      // Metadata may still be arriving; retain the user's seek until it is available.
    }
  }

  private releaseSong(): void {
    this.cancelSongFade();
    const old = this.song;
    this.song = undefined;
    this.songTrackId = undefined;
    this.songGain = 1;
    this.pendingSeek = null;
    if (!old) return;
    old.pause();
    old.removeAttribute("src");
    old.load();
  }

  private setSongGain(gain: number): void {
    this.songGain = unit(gain);
    if (this.song) this.song.volume = unit(this.value.volume * this.songGain);
  }

  private fadeSong(audio: HTMLAudioElement, target: number): Promise<void> {
    this.cancelSongFade();
    if (this.song !== audio) return Promise.resolve();
    const start = this.songGain;
    if (audio.paused || audio.ended || Math.abs(start - target) < 0.001) {
      this.setSongGain(target);
      return Promise.resolve();
    }
    const startedAt = performance.now();
    return new Promise((resolve) => {
      const fade: Fade & { target: number } = {
        timer: 0 as unknown as ReturnType<typeof setTimeout>,
        finish: resolve, target,
      };
      const step = () => {
        if (this.songFade !== fade) return;
        const progress = Math.min(1, (performance.now() - startedAt) / SONG_FADE_MS);
        this.setSongGain(start + (target - start) * progress);
        if (progress < 1) fade.timer = setTimeout(step, 16);
        else {
          this.songFade = undefined;
          resolve();
        }
      };
      this.songFade = fade;
      step();
    });
  }

  private cancelSongFade(): void {
    if (!this.songFade) return;
    const fade = this.songFade;
    this.songFade = undefined;
    clearTimeout(fade.timer);
    fade.finish();
  }

  private expectsSong(): boolean {
    return this.transport === "loading" || this.transport === "playing";
  }

  private unsupported(track: MusicTrack): string | null {
    if (!track.browserPlayable && !track.localDecodable && !isDsdTrack(track))
      return `${track.format} 无法在当前浏览器中播放，请选择浏览器支持的音频文件。`;
    return null;
  }

  private playbackError(track: MusicTrack, error: unknown): string {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError")
      return "浏览器暂未允许播放，请点击播放按钮重试。";
    const media = this.song?.error;
    if (media?.code === 2)
      return "音频读取失败：请检查本地服务和音乐文件是否仍然可用。";
    if (name === "AbortError") return "歌曲播放被中断，请点击播放按钮重试。";
    if (/M4A|ALAC/i.test(`${track.format} ${track.codec ?? ""}`)) {
      return "此 M4A / ALAC 文件未能由当前浏览器解码，或文件已不可用。请检查原文件，或尝试支持该编码的浏览器。";
    }
    if (
      media?.code === 3 ||
      media?.code === 4 ||
      name === "NotSupportedError"
    ) {
      return `无法播放此 ${track.format} 文件：当前浏览器不支持它的编码，或文件已损坏、不可读取。`;
    }
    return `播放失败，请检查 ${track.format} 文件及本地音乐服务后重试。`;
  }

  private fail(message: string): void {
    ++this.operation;
    this.preparation?.abort();
    this.gapless?.stop(); this.cancelNativeNext();
    if (this.value.backend === "coreaudio") void this.nativeCommand({ action: "stop" }).catch(() => {});
    this.transport = "error";
    this.releaseSong();
    this.value.playing = false;
    this.value.loading = false;
    this.value.error = message;
    this.emit();
    void this.reconcileBgm();
  }

  private gaplessWarning(error?: unknown): void {
    this.gaplessFallback = true;
    if (!error && this.value.transitionWarning) return;
    const message = error instanceof Error ? error.message : "";
    // Server and decoder errors can contain local paths; only our fixed public
    // messages cross this UI boundary.
    this.value.transitionWarning = /本次队列改用普通播放。$/.test(message) && !/[\\/]/.test(message)
      ? message : "暂时无法保证连续音频接续，本次队列改用普通播放。";
    this.emit();
  }

  private async playGapless(track: MusicTrack, queue: readonly MusicTrack[], index: number): Promise<void> {
    void this.gapless?.trackId;
    const request = ++this.operation;
    const same = this.value.currentTrack?.id === track.id;
    const position = same ? this.pendingSeek ?? (this.gapless?.trackId === track.id ? this.gapless.position : this.value.currentTime) : 0;
    this.preparation?.abort();
    const controller = new AbortController(); this.preparation = controller;
    this.releaseSong();
    this.value.queue = [...queue]; this.value.currentTrack = track; this.value.currentIndex = index;
    this.value.currentTime = position; this.value.duration = seconds(track.duration);
    this.value.playing = false; this.value.loading = true; this.value.error = null;
    this.transport = "loading"; this.emit();
    try {
      this.gapless ??= new BrowserGaplessPlayer({
        progress: (current, position, duration) => {
          if (this.disposed || this.value.backend !== "browser" || this.value.currentTrack?.id !== current.id) return;
          this.value.currentTime = position; this.value.duration = duration; this.emit();
        },
        boundary: (current, duration) => {
          if (this.disposed || this.value.backend !== "browser" || this.value.songTransitionMode !== "gapless") return;
          const index = this.value.queue.findIndex(item => item.id === current.id);
          if (index < 0) { this.stop(); return; }
          this.value.currentTrack = current; this.value.currentIndex = index;
          this.value.currentTime = 0; this.value.duration = duration;
          this.value.playing = true; this.value.loading = false; this.transport = "playing";
          this.emit(); this.prepareSuccessor();
        },
        ended: () => {
          if (this.disposed || this.value.backend !== "browser" || this.transport !== "playing") return;
          const next = this.value.queue[this.value.currentIndex + 1];
          if (next) { this.gaplessWarning(); void this.play(next.id); }
          else {
            this.transport = "idle"; this.value.playing = false;
            this.value.currentTime = this.value.duration; this.emit(); void this.reconcileBgm();
          }
        },
        interrupted: position => {
          if (this.disposed || this.value.backend !== "browser") return;
          ++this.operation; this.preparation?.abort();
          this.value.currentTime = position; this.value.playing = false; this.value.loading = false;
          this.transport = "paused"; this.emit();
        },
      });
      this.gapless.volume(this.value.volume);
      // resume() is invoked in this synchronous gesture turn, before any await.
      const unlocked = this.gapless.unlock();
      await Promise.all([unlocked, this.reconcileBgm()]);
      if (request !== this.operation || this.disposed) return;
      await this.gapless.play(track, position, controller.signal);
      if (request !== this.operation || this.disposed) return;
      if (this.pendingSeek !== null) { this.gapless.seek(this.pendingSeek); this.pendingSeek = null; }
      this.value.duration = this.gapless.duration; this.value.currentTime = this.gapless.position;
      this.value.playing = true; this.value.loading = false; this.transport = "playing";
      this.emit(); this.prepareSuccessor();
    } catch (error) {
      if (request !== this.operation || this.disposed || controller.signal.aborted) return;
      if (error instanceof AudioClockSuspended) {
        this.value.playing = false; this.value.loading = false; this.transport = "paused";
        this.emit(); return;
      }
      this.gapless?.stop(); this.gaplessWarning(error);
      this.pendingSeek = position > 0 ? position : null;
      await this.play(track.id);
    } finally { if (this.preparation === controller) this.preparation = undefined; }
  }

  private prepareSuccessor(): void {
    if (this.disposed || this.value.songTransitionMode !== "gapless" || this.gaplessFallback || this.transport !== "playing") return;
    const next = this.value.queue[this.value.currentIndex + 1];
    const operation = this.operation;
    if (this.value.backend === "browser") {
      void this.gapless?.prepareNext(next).catch(error => {
        if (operation !== this.operation || this.disposed || (error instanceof DOMException && error.name === "AbortError")) return;
        this.gaplessWarning(error);
      });
    } else {
      const cancelled = this.cancelNativeNext();
      const generation = this.nativePrepareGeneration;
      void cancelled.then(() => {
        if (generation !== this.nativePrepareGeneration || this.disposed || operation !== this.operation) return;
        const next = this.value.queue[this.value.currentIndex + 1];
        if (!next) return;
        this.nativePreparedId = next.id;
        return this.nativeCommand({ action: "prepareNext", trackId: next.id, afterTrackId: this.value.currentTrack?.id });
      }).catch(error => {
        if (operation !== this.operation || generation !== this.nativePrepareGeneration || this.disposed) return;
        this.nativePreparedId = undefined; this.gaplessWarning(error);
      });
    }
  }

  private cancelNativeNext(adopt = true): Promise<void> {
    const expected = this.nativePreparedId ?? this.nativeHandoffId;
    this.nativeHandoffId = adopt ? expected : undefined;
    const operation = this.operation;
    ++this.nativePrepareGeneration; this.nativePreparedId = undefined;
    if (!this.disposed && this.value.backend === "coreaudio")
      return this.nativeCommand({ action: "cancelNext" }).then(state => {
        if (adopt && !this.disposed && operation === this.operation && this.value.backend === "coreaudio") {
          this.adoptNativePosition(state, expected); this.nativeHandoffId = undefined;
        }
      }, () => {});
    return Promise.resolve();
  }

  private adoptNativePosition(state: NativeState, successor?: string): void {
    if (state.trackId !== this.value.currentTrack?.id && state.trackId === successor) {
      const index = this.value.queue.findIndex(track => track.id === state.trackId);
      if (index >= 0) { this.value.currentIndex = index; this.value.currentTrack = this.value.queue[index]; }
      else {
        this.stop(); this.value.currentTrack = null; this.value.currentIndex = -1; this.value.duration = 0;
        this.emit(); return;
      }
    }
    if (state.trackId === this.value.currentTrack?.id) {
      this.value.currentTime = state.currentTime; this.value.duration = state.duration;
    }
  }

  private async nativeCommand(command: Record<string, unknown>, keepalive = false): Promise<NativeState> {
    const response = await fetch("/api/output/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command), keepalive });
    const result = await response.json() as NativeState & { error?: string };
    if (!response.ok) throw new Error(result.error || "CoreAudio 输出失败");
    return result;
  }

  private async playNative(track: MusicTrack, queue: readonly MusicTrack[], index: number): Promise<void> {
    const request = ++this.operation;
    const cancelled = this.cancelNativeNext(false);
    const same = this.value.currentTrack?.id === track.id;
    if (!same) this.pendingSeek = null;
    this.value.queue = [...queue]; this.value.currentTrack = track; this.value.currentIndex = index;
    this.value.loading = true; this.value.playing = false; this.value.error = null;
    this.value.currentTime = same ? this.value.currentTime : 0;
    this.value.duration = seconds(track.duration); this.transport = "loading"; this.emit();
    await Promise.all([cancelled, this.reconcileBgm()]);
    if (request !== this.operation || this.disposed) return;
    try {
      const state = await this.nativeCommand({ action: "play", trackId: track.id, deviceId: this.value.outputDeviceId, volume: this.value.volume, transitionMode: this.value.songTransitionMode });
      if (request !== this.operation || this.disposed) return;
      this.nativeEndedSerial = state.endedSerial;
      this.value.duration = state.duration; this.value.currentTime = state.currentTime;
      this.value.playing = state.playing; this.value.loading = false;
      this.transport = state.playing ? "playing" : "paused";
      this.emit(); this.startNativePoll();
      if (this.pendingSeek !== null) { const position = this.pendingSeek; this.pendingSeek = null; this.seek(position); }
      else this.prepareSuccessor();
    } catch (error) { if (request === this.operation && !this.disposed) this.fail(error instanceof Error ? error.message : "CoreAudio 播放失败"); }
  }

  private startNativePoll(): void {
    this.stopNativePoll();
    const epoch = this.nativePollEpoch;
    const poll = async () => {
      if (this.disposed || this.value.backend !== "coreaudio" || epoch !== this.nativePollEpoch) return;
      const request = this.operation;
      try {
        const response = await fetch("/api/output/state");
        const state = await response.json() as NativeState & { error?: string };
        if (!response.ok) throw new Error(state.error || "无法读取 CoreAudio 状态");
        if (this.disposed || this.value.backend !== "coreaudio" || epoch !== this.nativePollEpoch) return;
        if (request === this.operation && this.transport === "playing" && state.trackId !== this.value.currentTrack?.id) {
          const index = this.value.queue.findIndex(track => track.id === state.trackId);
          if ((state.trackId === this.nativePreparedId || state.trackId === this.nativeHandoffId) && index >= 0) {
            this.value.currentTrack = this.value.queue[index]; this.value.currentIndex = index;
            if (state.playing) this.prepareSuccessor();
          } else throw new Error("CoreAudio 播放进程已重启或状态已改变，请重新播放");
        }
        if (request === this.operation && state.trackId === this.value.currentTrack?.id && this.transport !== "loading") {
          if (state.error) throw new Error(state.error);
          this.value.currentTime = state.currentTime; this.value.duration = state.duration;
          this.value.playing = state.playing;
          if (state.endedSerial !== this.nativeEndedSerial && this.transport === "playing") {
            this.nativeEndedSerial = state.endedSerial;
            const next = this.value.queue[this.value.currentIndex + 1];
            if (next) {
              if (this.value.songTransitionMode === "gapless") this.gaplessWarning();
              void this.play(next.id);
            }
            else { this.transport = "idle"; this.value.playing = false; void this.reconcileBgm(); }
          }
          this.emit();
        }
      } catch (error) {
        if (!this.disposed && request === this.operation && this.value.backend === "coreaudio" && this.expectsSong()) this.fail(error instanceof Error ? error.message : "CoreAudio 连接已断开");
      }
      if (!this.disposed && this.value.backend === "coreaudio" && epoch === this.nativePollEpoch) this.nativePoll = setTimeout(poll, 200);
    };
    this.nativePoll = setTimeout(poll, 200);
  }

  private stopNativePoll(): void { ++this.nativePollEpoch; if (this.nativePoll) clearTimeout(this.nativePoll); this.nativePoll = undefined; }

  private onGesture = (): void => {
    if (this.disposed) return;
    this.gestureReceived = true;
    void this.reconcileBgm();
  };

  private onBgmError = (): void => {
    if (this.disposed) return;
    ++this.bgmOperation;
    this.cancelFade();
    this.bgm.pause();
    this.bgm.volume = 0;
    this.bgmTarget = -1;
    this.value.bgmPlaying = false;
    this.value.bgmError = "氛围配乐无法加载，歌曲播放功能仍可使用。";
    this.emit();
  };

  private reconcileBgm(): Promise<void> {
    const idle = this.transport === "idle" || this.transport === "error";
    const target =
      !this.disposed && this.gestureReceived && this.value.bgmEnabled && idle
        ? this.value.bgmVolume
        : 0;
    if (target === this.bgmTarget) return this.bgmTask;
    this.bgmTarget = target;
    const request = ++this.bgmOperation;
    this.cancelFade();
    this.bgmTask = (async () => {
      if (target > 0) {
        try {
          await this.bgm.play();
          if (this.disposed || request !== this.bgmOperation) {
            if (this.disposed || this.bgmTarget <= 0) this.bgm.pause();
            return;
          }
          this.value.bgmError = null;
          this.value.bgmPlaying = true;
          this.emit();
        } catch {
          if (!this.disposed && request === this.bgmOperation) {
            this.bgmTarget = -1;
            this.value.bgmPlaying = false;
            this.value.bgmError =
              "氛围配乐暂未获准播放或无法读取，请再次点击界面重试。";
            this.emit();
          }
          return;
        }
      }
      if (this.disposed || request !== this.bgmOperation) return;
      await this.fadeBgm(target, target > 0 ? 650 : 220);
      if (this.disposed || request !== this.bgmOperation) return;
      if (target === 0) this.bgm.pause();
      this.value.bgmPlaying = target > 0 && !this.bgm.paused;
      this.emit();
    })();
    return this.bgmTask;
  }

  private fadeBgm(target: number, duration: number): Promise<void> {
    this.cancelFade();
    const start = this.bgm.volume;
    if (this.bgm.paused || Math.abs(start - target) < 0.001) {
      this.bgm.volume = target;
      return Promise.resolve();
    }
    const startedAt = performance.now();
    return new Promise((resolve) => {
      const fade: Fade = {
        timer: 0 as unknown as ReturnType<typeof setTimeout>,
        finish: resolve,
      };
      const step = () => {
        if (this.fade !== fade) return;
        const progress = Math.min(
          1,
          (performance.now() - startedAt) / duration,
        );
        this.bgm.volume = unit(start + (target - start) * progress);
        if (progress < 1) fade.timer = setTimeout(step, 24);
        else {
          this.fade = undefined;
          resolve();
        }
      };
      this.fade = fade;
      step();
    });
  }

  private cancelFade(): void {
    if (!this.fade) return;
    const fade = this.fade;
    this.fade = undefined;
    clearTimeout(fade.timer);
    fade.finish();
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (error) {
        console.error("MusicPlayer state listener failed", error);
      }
    }
  }
}
