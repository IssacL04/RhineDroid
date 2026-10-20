import type { MusicTrack } from "./music-types";

// This budget includes resident Float32 samples, the next encoded WAV and a
// second encoded-size decode workspace reservation. It is not a browser heap cap.
export const GAPLESS_MEMORY_BYTES = 384 * 1024 * 1024;
export const GAPLESS_FILE_BYTES = 128 * 1024 * 1024;
export class AudioClockSuspended extends Error {}
const cancelled = () => new DOMException("Playback superseded", "AbortError");
const limit = () => new Error("曲目超过无缝播放的内存预算，本次队列改用普通播放。");
const bytesOf = (buffer?: AudioBuffer) => buffer ? buffer.length * buffer.numberOfChannels * 4 : 0;

/** Validate actual PCM dimensions before decodeAudioData can allocate samples. */
export function pcmWaveFrames(data: ArrayBuffer): { frames: number; channels: number; sampleRate: number } {
  const view = new DataView(data);
  const word = (at: number) => String.fromCharCode(...new Uint8Array(data, at, 4));
  if (data.byteLength < 44 || word(0) !== "RIFF" || word(8) !== "WAVE") throw new Error("无缝播放需要有效的本地 PCM 音源。");
  let channels = 0, sampleRate = 0, align = 0, samples = 0;
  for (let at = 12; at + 8 <= data.byteLength;) {
    const size = view.getUint32(at + 4, true), start = at + 8;
    if (start + size > data.byteLength) throw new Error("无缝播放音源不完整。");
    if (word(at) === "fmt " && size >= 16) {
      const codec = view.getUint16(start, true);
      if (![1, 3, 65534].includes(codec)) throw new Error("无缝播放需要 PCM 音源。");
      channels = view.getUint16(start + 2, true); sampleRate = view.getUint32(start + 4, true);
      align = view.getUint16(start + 12, true);
      const bits = view.getUint16(start + 14, true);
      if (![16, 24, 32].includes(bits) || align !== channels * bits / 8) throw new Error("无缝播放音源格式不受支持。");
    }
    if (word(at) === "data") samples += size;
    at = start + size + (size % 2);
  }
  if (!channels || channels > 8 || sampleRate < 8000 || sampleRate > 768000 || !align || !samples || samples % align) throw new Error("无缝播放音源的采样信息无效。");
  return { frames: samples / align, channels, sampleRate };
}

type Slot = { track: MusicTrack; buffer: AudioBuffer; source?: AudioBufferSourceNode; start: number; offset: number };
export interface GaplessCallbacks {
  progress(track: MusicTrack, position: number, duration: number): void;
  boundary(track: MusicTrack, duration: number): void;
  ended(): void;
  interrupted?(position: number): void;
}

/** Owns at most two sources. The next source starts on the audio rendering clock. */
export class BrowserGaplessPlayer {
  private readonly context: AudioContext;
  private readonly gain: GainNode;
  private current?: Slot;
  private next?: Slot;
  private nextAbort?: AbortController;
  private nextGeneration = 0;
  private generation = 0;
  private playing = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private decodeTail: Promise<unknown> = Promise.resolve();
  private callbacks: GaplessCallbacks;

  constructor(callbacks: GaplessCallbacks, context?: AudioContext) {
    this.callbacks = callbacks;
    this.context = context ?? new AudioContext();
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
    this.context.addEventListener?.("statechange", this.onStateChange);
  }

  /** Call synchronously from the user play gesture, before any fetch or BGM wait. */
  unlock(): Promise<void> { return this.context.resume(); }
  volume(value: number): void { this.gain.gain.value = Math.max(0, Math.min(1, value)); }
  get trackId(): string | undefined { this.sync(); return this.current?.track.id; }
  get position(): number {
    this.sync();
    const slot = this.current;
    return slot ? Math.min(slot.buffer.duration, slot.offset + (this.playing ? Math.max(0, this.context.currentTime - slot.start) : 0)) : 0;
  }
  get duration(): number { return this.current?.buffer.duration ?? 0; }
  get residentBytes(): number { return bytesOf(this.current?.buffer) + bytesOf(this.next?.buffer); }

  async play(track: MusicTrack, offset: number, signal: AbortSignal): Promise<void> {
    const token = ++this.generation;
    const retained = this.current?.track.id === track.id ? this.current.buffer : undefined;
    this.clearSources(); this.current = undefined;
    const buffer = retained ?? await this.load(track, signal);
    if (this.disposed || token !== this.generation || signal.aborted) throw cancelled();
    this.current = { track, buffer, offset: Math.max(0, Math.min(buffer.duration, offset)), start: this.context.currentTime + 0.04 };
    if (this.context.state && this.context.state !== "running") throw new AudioClockSuspended();
    this.playing = true;
    this.start(this.current);
    this.poll();
  }

  async prepareNext(track?: MusicTrack): Promise<void> {
    this.sync();
    if (track && this.next?.track.id === track.id) return;
    this.cancelNext();
    if (!track || !this.current || !this.playing) return;
    const owner = this.current;
    const token = this.nextGeneration;
    const controller = new AbortController(); this.nextAbort = controller;
    const buffer = await this.load(track, controller.signal);
    if (this.disposed || controller.signal.aborted || token !== this.nextGeneration || owner !== this.current || !this.playing) throw cancelled();
    const boundary = owner.start + owner.buffer.duration - owner.offset;
    if (boundary - this.context.currentTime < 0.025) throw new Error("下一首未能及时完成预备，本次队列改用普通播放。");
    this.next = { track, buffer, offset: 0, start: boundary };
    this.start(this.next);
  }

  pause(): number {
    ++this.generation;
    const position = this.position;
    this.clearSources();
    if (this.current) this.current.offset = position;
    return position;
  }

  seek(position: number): void {
    this.sync();
    if (!this.current) return;
    const wasPlaying = this.playing;
    this.clearSources();
    this.current.offset = Math.max(0, Math.min(this.current.buffer.duration, position));
    this.current.start = this.context.currentTime + 0.04;
    this.playing = wasPlaying;
    if (wasPlaying) { this.start(this.current); this.poll(); }
    this.callbacks.progress(this.current.track, this.current.offset, this.current.buffer.duration);
  }

  cancelNext(): void {
    ++this.nextGeneration;
    this.nextAbort?.abort(); this.nextAbort = undefined;
    this.release(this.next); this.next = undefined;
  }

  stop(): void { ++this.generation; this.clearSources(); this.current = undefined; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.stop(); this.gain.disconnect();
    this.context.removeEventListener?.("statechange", this.onStateChange);
    void this.context.close().catch(() => {});
  }

  private start(slot: Slot): void {
    const source = this.context.createBufferSource();
    source.buffer = slot.buffer; source.connect(this.gain); slot.source = source;
    // Do not use an onended callback to start another source: it is already
    // scheduled. A delayed main thread can only delay UI state, never this seam.
    source.onended = () => { if (slot.source === source) this.sync(); };
    source.start(slot.start, slot.offset);
  }

  private sync(): void {
    if (!this.playing || !this.current) return;
    const now = this.context.currentTime;
    if (this.next && now >= this.next.start) {
      this.release(this.current);
      this.current = this.next; this.next = undefined;
      this.nextAbort = undefined;
      this.callbacks.boundary(this.current.track, this.current.buffer.duration);
    }
    if (this.current && now >= this.current.start + this.current.buffer.duration - this.current.offset) {
      this.playing = false; this.current.offset = this.current.buffer.duration;
      this.release(this.current); this.callbacks.ended();
    }
  }

  private poll(): void {
    clearTimeout(this.timer);
    if (this.disposed || !this.playing) return;
    this.sync();
    if (this.current && this.playing) {
      this.callbacks.progress(this.current.track, this.position, this.current.buffer.duration);
      this.timer = setTimeout(() => this.poll(), 100);
    }
  }

  private release(slot?: Slot): void {
    if (!slot?.source) return;
    slot.source.onended = null;
    try { slot.source.stop(); } catch {}
    slot.source.disconnect(); slot.source = undefined;
  }
  private clearSources(): void {
    this.playing = false; this.cancelNext(); this.release(this.current);
    clearTimeout(this.timer); this.timer = undefined;
  }

  private onStateChange = (): void => {
    if (!this.disposed && this.playing && this.context.state !== "running") {
      const position = this.pause();
      this.callbacks.interrupted?.(position);
    }
  };

  private load(track: MusicTrack, signal: AbortSignal): Promise<AudioBuffer> {
    // Keep cancelled decodeAudioData work in the serial queue until it settles:
    // it cannot be aborted, so starting another decoder would break the budget.
    const job = this.decodeTail.catch(() => {}).then(async () => {
      if (signal.aborted || this.disposed) throw cancelled();
      const prepared = await fetch(`/api/audio/prepare/${encodeURIComponent(track.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal });
      const metadata = await prepared.json() as { bytes?: number; audioUrl?: string };
      if (!prepared.ok) throw new Error("本地音源暂时无法预备，本次队列改用普通播放。");
      const size = metadata.bytes;
      if (!Number.isFinite(size) || !size || size < 44 || size > GAPLESS_FILE_BYTES) throw limit();
      if (this.residentBytes + size * 2 > GAPLESS_MEMORY_BYTES) throw limit();
      const response = await fetch(metadata.audioUrl || `/api/decoded-audio/${encodeURIComponent(track.id)}`, { signal });
      if (!response.ok || !response.body) throw new Error("无缝播放音源读取失败，本次队列改用普通播放。");
      const length = Number(response.headers.get("Content-Length"));
      if (length > size || length > GAPLESS_FILE_BYTES) { await response.body.cancel(); throw limit(); }
      // The server's measured file size bounds allocation before reading. Also
      // enforce it during streaming instead of trusting Content-Length alone.
      let data: Uint8Array<ArrayBuffer> | undefined = new Uint8Array(size);
      const reader = response.body.getReader(); let used = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (signal.aborted || this.disposed) throw cancelled();
          if (used + value.length > size) throw limit();
          data.set(value, used); used += value.length;
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      if (used !== size) throw new Error("无缝播放音源不完整，本次队列改用普通播放。");
      const pcm = pcmWaveFrames(data.buffer);
      const decodedBytes = (Math.ceil(pcm.frames * this.context.sampleRate / pcm.sampleRate) + 8) * pcm.channels * 4;
      if (decodedBytes + size * 2 + this.residentBytes > GAPLESS_MEMORY_BYTES) throw limit();
      if (signal.aborted || this.disposed) throw cancelled();
      const buffer = await this.context.decodeAudioData(data.buffer);
      data = undefined;
      if (signal.aborted || this.disposed) throw cancelled();
      if (bytesOf(buffer) > decodedBytes || bytesOf(buffer) + this.residentBytes > GAPLESS_MEMORY_BYTES) throw limit();
      return buffer;
    });
    this.decodeTail = job.then(() => {}, () => {});
    return job;
  }
}
