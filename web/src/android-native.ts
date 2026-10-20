import { AndroidDemoPlayer } from "./android-demo-player.ts";
import type { MusicTrack } from "./music-types";
import type { MusicPlayerState } from "./music-player";

type Host = { postMessage(message: string): void };
export const nativeAvailable = () => !!(window as unknown as { RhineHost?: Host }).RhineHost;
let serial = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
export function nativeRequest<T>(type: string, data: Record<string, unknown> = {}): Promise<T> {
  const host = (window as unknown as { RhineHost?: Host }).RhineHost;
  if (!host) return Promise.reject(new Error("此操作需要在 Android 应用中使用。"));
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("原生服务响应超时，请重试。")); }, 15000);
    pending.set(id, { resolve: value => resolve(value as T), reject, timer });
    try { host.postMessage(JSON.stringify({ ...data, type, id })); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}
export const nativeCommand = (type: string, data: Record<string, unknown> = {}) => nativeRequest<void>(type,data);
window.addEventListener("rhine-native", ((event: CustomEvent) => {
  const value = event.detail;
  if (value?.type !== "response") return;
  const request = pending.get(value.id);
  if (!request) return;
  clearTimeout(request.timer); pending.delete(value.id);
  value.error ? request.reject(new Error(value.error)) : request.resolve(value.result);
}) as EventListener);

/** The Android service owns audio; closing or rotating the page never stops it. */
export class AndroidMusicPlayer extends AndroidDemoPlayer {
  private tracks = new Map<string, MusicTrack>();
  private receive = ((event: CustomEvent) => {
    const state = event.detail;
    if (this.disposed || state?.type !== "player") return;
    this.value = { ...this.value, currentTrack: state.track, playing: state.playing, loading: state.loading,
      transport: state.transport, currentIndex: state.currentIndex, currentTime: state.currentTime,
      duration: state.duration || state.track?.duration || 0, volume: state.volume, error: state.error,
      songTransitionMode:state.audio?.songTransition ?? this.value.songTransitionMode,
      bgmEnabled:state.audio?.bgm ?? this.value.bgmEnabled, bgmVolume:state.audio?.bgmVolume ?? this.value.bgmVolume,
      bgmPlaying:state.audio?.bgmPlaying ?? false,
      outputDeviceId:state.audio?.outputDevice ?? this.value.outputDeviceId,
      outputDevices:state.audio?.outputDevices ?? this.value.outputDevices,
      nativeAvailable: true, queue: state.queue ? state.queue.map((id: string) => this.tracks.get(id)).filter(Boolean) : this.value.queue };
    this.emit();
  }) as EventListener;
  constructor(options: ConstructorParameters<typeof AndroidDemoPlayer>[0] = {}) {
    super(options);
    window.addEventListener("rhine-native", this.receive);
  }
  setTracks(tracks: MusicTrack[]) { this.tracks = new Map(tracks.map(track => [track.id, track])); }
  private async command(type: string, data: Record<string, unknown> = {}) {
    try { await nativeCommand(type, data); }
    catch (error) { this.value = { ...this.value, error: (error as Error).message }; this.emit(); }
  }
  override async play(id: string, tracks: readonly MusicTrack[]) {
    if (!nativeAvailable()) return super.play(id, tracks);
    if (this.disposed) return;
    await this.command("play", { trackId: id, tracks: [...new Set(tracks.map(track => track.id))] });
  }
  override async toggle() { if (nativeAvailable()) await this.command("toggle"); else await super.toggle(); }
  override stop() { if (nativeAvailable()) void this.command("stop"); else super.stop(); }
  override setVolume(volume: number) {
    if (!Number.isFinite(volume)) return;
    if (nativeAvailable()) void this.command("volume", { volume: Math.max(0, Math.min(1, volume)) });
    else super.setVolume(volume);
  }
  seek(seconds: number) { if (Number.isFinite(seconds) && seconds >= 0) void this.command("seek", { seconds }); }
  next() { void this.command("next"); }
  previous() { void this.command("previous"); }
  override setSongTransitionMode(mode: import("./music-song-transition").SongTransitionMode) {
    super.setSongTransitionMode(mode);
    if (nativeAvailable()) void this.command("audio-settings", {songTransition:mode});
  }
  override setBgmEnabled(enabled: boolean) { if (nativeAvailable()) void this.command("audio-settings", {bgm:enabled}); }
  override setBgmVolume(volume: number) { if (Number.isFinite(volume) && nativeAvailable()) void this.command("audio-settings", {bgmVolume:Math.max(0,Math.min(1,volume))}); }
  override async refreshOutputs() {
    await this.command("audio-outputs");
    return {decoderAvailable:true,nativeAvailable:true,devices:this.state.outputDevices};
  }
  override async setOutputDevice(deviceId: string) { await this.command("audio-settings", {outputDevice:deviceId}); }
  override dispose() { window.removeEventListener("rhine-native", this.receive); super.dispose(); }
}
