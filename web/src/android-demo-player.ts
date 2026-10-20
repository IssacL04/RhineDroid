import type { AudioCapabilities, MusicPlayerState } from "./music-player";
import type { MusicTrack } from "./music-types";
import { normalizeSongTransition, type SongTransitionMode } from "./music-song-transition.ts";

/** Silent transport state for the UI prototype; no Audio, timers, or service calls. */
export class AndroidDemoPlayer {
  protected value: MusicPlayerState;
  protected disposed = false;
  private listeners = new Set<(state: MusicPlayerState) => void>();

  constructor(options: { volume?: number; songTransitionMode?: SongTransitionMode; bgmEnabled?: boolean; bgmVolume?: number } = {}) {
    const transition = normalizeSongTransition(options.songTransitionMode);
    this.value = {
      transport: "idle", currentTrack: null, queue: [], currentIndex: -1,
      playing: false, loading: false, duration: 0, currentTime: 0,
      volume: options.volume ?? 0.65, songTransitionMode: transition,
      songFadeEnabled: transition !== "gapless", bgmVolume: 0, bgmEnabled: false,
      bgmPlaying: false, error: null, bgmError: null, backend: "browser",
      outputDeviceId: "default", outputDevices: [], decoderAvailable: false,
      nativeAvailable: false, outputError: null, transitionWarning: null,
    };
  }

  get state(): MusicPlayerState { return { ...this.value, queue: [...this.value.queue] }; }

  subscribe(listener: (state: MusicPlayerState) => void) {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }

  async play(id: string, tracks: readonly MusicTrack[]) {
    if (this.disposed) return;
    const queue = tracks.filter((track, index) => tracks.findIndex((item) => item.id === track.id) === index);
    const index = queue.findIndex((track) => track.id === id);
    if (index < 0) return;
    const track = queue[index];
    this.value = { ...this.value, queue, currentIndex: index, currentTrack: track,
      transport: "playing", playing: true, currentTime: 0, duration: track.duration };
    this.emit();
  }

  async toggle() {
    if (this.disposed || !this.value.currentTrack) return;
    this.value.playing = !this.value.playing;
    this.value.transport = this.value.playing ? "playing" : "paused";
    this.emit();
  }

  stop() {
    if (this.disposed) return;
    this.value = { ...this.value, transport: "idle", playing: false, currentTime: 0 };
    this.emit();
  }

  setVolume(volume: number) {
    if (!Number.isFinite(volume) || this.disposed) return;
    this.value.volume = Math.min(1, Math.max(0, volume));
    this.emit();
  }
  setSongTransitionMode(mode: SongTransitionMode) {
    if (this.disposed) return;
    this.value.songTransitionMode = normalizeSongTransition(mode);
    this.value.songFadeEnabled = this.value.songTransitionMode !== "gapless";
    this.emit();
  }
  setBgmVolume(_volume: number) {}
  setBgmEnabled(_enabled: boolean) {}
  async refreshOutputs(): Promise<AudioCapabilities> { throw new Error("此版本仅提供静音界面演示。"); }
  async setBackend(_backend: string, _deviceId: string) { throw new Error("此版本仅提供静音界面演示。"); }
  async setOutputDevice(_deviceId: string) { throw new Error("此版本仅提供静音界面演示。"); }

  dispose() { this.disposed = true; this.listeners.clear(); }
  protected emit() { for (const listener of this.listeners) listener(this.state); }
}
