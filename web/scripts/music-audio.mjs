import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SOURCE = fileURLToPath(new URL('../native/RhineAudio.swift', import.meta.url))
const MAX_PCM_BYTES = 2 * 1024 ** 3
const MAX_CACHE_BYTES = 4 * 1024 ** 3
// Never let a mislabeled audio file open concat/HLS playlists or secondary local paths.
const AUDIO_DEMUXERS = 'ape,wav,flac,mov,mp3,aac,aiff,ogg,wv,asf,dsf,iff'
const isDsdCodec = (codec) => /^(dsd_(lsbf|msbf)(_planar)?|dst)$/.test(codec)
const DSD_PCM_RATE = 176400
const TRANSITION_MODES = new Set(['fade-out', 'fade-in-out', 'gapless'])
const aborted = () => Object.assign(new Error('音频准备已取消'), { name: 'AbortError', status: 499 })
const failure = (message, status = 503) => Object.assign(new Error(message), { status })
const exists = async (file) => { try { await fs.access(file, constants.X_OK); return file } catch { return null } }
export async function findExecutable(name, override) {
  if (override) {
    if (!path.isAbsolute(override)) throw failure(`${name} 路径必须是绝对路径`)
    return exists(override)
  }
  for (const candidate of [...(override ? [override] : []), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`, ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name))]) {
    if (override && candidate === override && !path.isAbsolute(candidate)) throw failure(`${name} 路径必须是绝对路径`)
    if (await exists(candidate)) return candidate
  }
  return null
}
export async function checkedSource(descriptor) {
  if (!descriptor) throw failure('索引中没有此音频', 404)
  const [file, root] = await Promise.all([fs.realpath(descriptor.path), fs.realpath(descriptor.allowedRoot)])
  const relative = path.relative(root, file)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw failure('文件已移出配置的音乐目录', 403)
  const stat = await fs.stat(file)
  if (!stat.isFile()) throw failure('音频文件不存在', 404)
  return { file, stat }
}
export function runProcess(binary, args, { signal, timeout = 120000, stdio } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted())
    const child = spawn(binary, args, { stdio: stdio ?? ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false })
    let output = '', errors = '', timedOut = false, forceKill
    const kill = () => { child.kill('SIGTERM'); forceKill = setTimeout(() => child.kill('SIGKILL'), 2000); forceKill.unref() }
    const timer = setTimeout(() => { timedOut = true; kill() }, timeout)
    signal?.addEventListener('abort', kill, { once: true })
    child.stdout?.on('data', (chunk) => { if (output.length < 1024 * 1024) output += chunk })
    child.stderr?.on('data', (chunk) => { errors = (errors + chunk).slice(-16000) })
    const clean = () => { clearTimeout(timer); clearTimeout(forceKill); signal?.removeEventListener('abort', kill) }
    child.on('error', (error) => { clean(); reject(error) })
    child.on('close', (code) => {
      clean()
      if (signal?.aborted) reject(aborted())
      else if (timedOut) reject(failure('音频处理超时，请检查文件后重试'))
      else if (code !== 0) reject(failure(`音频处理失败：${errors.trim().split('\n').slice(-2).join(' ').slice(0, 500) || `exit ${code}`}`, 422))
      else resolve(output)
    })
  })
}

export class AudioDecoder {
  constructor({ dataDir, ffmpeg, ffprobe } = {}) {
    this.cacheDir = path.join(dataDir, 'audio-cache-v040')
    this.ffmpegOverride = ffmpeg; this.ffprobeOverride = ffprobe
    this.jobs = new Map(); this.leases = new Map(); this.active = 0; this.waiters = []; this.disposed = false
  }
  async init() {
    if (!this.ready) this.ready = (async () => {
      this.ffmpeg = await findExecutable('ffmpeg', this.ffmpegOverride ?? process.env.FFMPEG_PATH)
      this.ffprobe = await findExecutable('ffprobe', this.ffprobeOverride ?? process.env.FFPROBE_PATH)
      if (!this.ffmpeg || !this.ffprobe) { this.error = '未找到 FFmpeg / ffprobe，请安装 FFmpeg 后重新启动'; this.ffmpeg = null; this.ffprobe = null; return }
      this.version = (await runProcess(this.ffmpeg, ['-version'], { timeout: 5000 })).split('\n')[0]
      await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 })
    })().catch((error) => { this.error = error.message; this.ffmpeg = null })
    await this.ready
    return this
  }
  async acquire(signal) {
    if (this.active >= 2) await new Promise((resolve, reject) => {
      const entry = { resolve: () => { signal.removeEventListener('abort', cancel); resolve() } }
      const cancel = () => { this.waiters = this.waiters.filter((item) => item !== entry); reject(aborted()) }
      signal.addEventListener('abort', cancel, { once: true }); this.waiters.push(entry)
    })
    if (signal.aborted) throw aborted()
    this.active += 1
  }
  release() { this.active -= 1; this.waiters.shift()?.resolve() }
  retain(file) {
    this.leases.set(file, (this.leases.get(file) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.leases.get(file) ?? 1) - 1
      if (remaining) this.leases.set(file, remaining)
      else this.leases.delete(file)
    }
  }
  async prepare(descriptor, { signal, retain = false, targetSampleRate } = {}) {
    if (targetSampleRate !== undefined && (!Number.isInteger(targetSampleRate) || targetSampleRate < 8000 || targetSampleRate > 768000)) throw failure('无效原生输出采样率', 400)
    await this.init()
    if (this.disposed || signal?.aborted) throw aborted()
    if (!this.ffmpeg || !this.ffprobe) throw failure('未找到 FFmpeg / ffprobe。请在本机安装 FFmpeg 后重新启动；浏览器原生支持的文件仍可直接播放。')
    const { file, stat } = await checkedSource(descriptor)
    const variant = targetSampleRate === undefined ? '' : `:native-float32-rate-${targetSampleRate}`
    const key = createHash('sha256').update(`${file}:${stat.size}:${stat.mtimeMs}:pcm-v4-dsd17640024${variant}`).digest('hex')
    const target = path.join(this.cacheDir, `${key}.wav`)
    // Pin before decode/prune can run, including cache hits and shared jobs.
    const release = retain ? this.retain(target) : null
    let job = this.jobs.get(key)
    if (!job) {
      const controller = new AbortController()
      job = { controller, users: 0 }
      job.promise = this.decode(file, target, controller.signal, targetSampleRate).finally(() => { if (this.jobs.get(key) === job) this.jobs.delete(key) })
      // Consumers observe this promise; retain a rejection handler during cancellation gaps.
      job.promise.catch(() => {})
      this.jobs.set(key, job)
    }
    job.users += 1
    try { const decoded = await new Promise((resolve, reject) => {
      let finished = false
      const finish = (callback, value) => {
        if (finished) return
        finished = true; signal?.removeEventListener('abort', cancel); job.users -= 1
        if (!job.users && this.jobs.get(key) === job) { this.jobs.delete(key); job.controller.abort() }
        callback(value)
      }
      const cancel = () => finish(reject, aborted())
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) return cancel()
      job.promise.then((value) => finish(resolve, value), (error) => finish(reject, error))
    }); return release ? { ...decoded, release } : decoded }
    catch (error) { release?.(); throw error }
  }
  async decode(file, target, signal, targetSampleRate) {
    const metadataFile = `${target}.json`
    try {
      const metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8'))
      const stat = await fs.stat(target)
      if (stat.size > 44) {
        await fs.utimes(target, new Date(), new Date())
        return { path: target, allowedRoot: this.cacheDir, mime: 'audio/wav', ...metadata, cached: true }
      }
    } catch {}
    await this.acquire(signal)
    const temporary = `${target}.${randomUUID()}.tmp.wav`
    try {
      const probe = JSON.parse(await runProcess(this.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', AUDIO_DEMUXERS, '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_sample,bits_per_raw_sample,sample_fmt,duration:format=duration,format_name', '-of', 'json', file], { signal, timeout: 20000 }))
      const stream = probe.streams?.[0]
      if (!stream || !Number(stream.sample_rate) || !Number(stream.channels)) throw failure('文件中没有可解码的音频轨道', 422)
      const dsd = isDsdCodec(stream.codec_name)
      let duration = Number(stream.duration ?? probe.format?.duration) || 0
      // FFmpeg reports the DSD byte clock / decoded PCM rate, not the 1-bit
      // source clock. Keep that distinction in the returned technical metadata.
      const sampleRate = targetSampleRate ?? (dsd ? DSD_PCM_RATE : Number(stream.sample_rate))
      const bits = Number(stream.bits_per_raw_sample || stream.bits_per_sample) || 0
      const float = /^(flt|dbl)/.test(stream.sample_fmt)
      const codec = targetSampleRate !== undefined ? 'pcm_f32le' : dsd ? 'pcm_s24le' : float ? 'pcm_f32le' : bits > 24 ? 'pcm_s32le' : bits > 16 ? 'pcm_s24le' : 'pcm_s16le'
      const bytes = codec === 'pcm_s16le' ? 2 : codec === 'pcm_s24le' ? 3 : 4
      if (duration * sampleRate * Number(stream.channels) * bytes > MAX_PCM_BYTES) throw failure('此音频的 PCM 缓存超过 2 GiB，请拆分超长音频后播放', 422)
      // DSD is decoded for playback; the source stays read-only. The built-in
      // antialiasing resampler needs no optional libsoxr and preserves channels.
      const conversion = dsd || targetSampleRate !== undefined ? ['-af', `aresample=${sampleRate}:resampler=swr:filter_size=64`, '-ar', String(sampleRate)] : []
      await runProcess(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...(dsd ? ['-xerror'] : []), '-protocol_whitelist', 'file,pipe', '-format_whitelist', AUDIO_DEMUXERS, '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', ...conversion, '-c:a', codec, '-threads', '1', '-fs', String(MAX_PCM_BYTES), '-f', 'wav', '-rf64', 'never', '-y', temporary], { signal, timeout: 5 * 60 * 1000 })
      const stat = await fs.stat(temporary)
      if (stat.size >= MAX_PCM_BYTES) throw failure('PCM 缓存已达到 2 GiB 限制', 422)
      if (stat.size <= 44) throw failure('音频解码没有产生有效数据', 422)
      if (dsd || targetSampleRate !== undefined) {
        // DSF's container duration can include block padding. Use the actual
        // resulting frames for playback duration, and verify before publishing.
        const decoded = JSON.parse(await runProcess(this.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_sample,duration:format=duration', '-of', 'json', temporary], { signal, timeout: 20000 }))
        const pcm = decoded.streams?.[0]
        duration = Number(pcm?.duration ?? decoded.format?.duration)
        if (pcm?.codec_name !== codec || Number(pcm.sample_rate) !== sampleRate || pcm.channels !== stream.channels || pcm.bits_per_sample !== bytes * 8 || !Number.isFinite(duration) || duration <= 0) throw failure('解码没有产生有效的 PCM 音频', 422)
      }
      const metadata = { duration, codec: stream.codec_name, container: probe.format?.format_name, sampleRate, channels: Number(stream.channels), pcmCodec: codec, bitsPerSample: bytes * 8, bytes: stat.size,
        ...(targetSampleRate !== undefined ? { normalizedSampleRate: targetSampleRate, sourceSampleRate: Number(stream.sample_rate) } : {}),
        ...(dsd ? { conversion: 'dsd-to-pcm', sourceSampleRate: Number(stream.sample_rate) * 8, sourceBitsPerSample: 1 } : {}),
      }
      await fs.chmod(temporary, 0o600); await fs.rename(temporary, target)
      await fs.writeFile(metadataFile, JSON.stringify(metadata), { mode: 0o600 })
      this.pruneTask = (this.pruneTask ?? Promise.resolve()).catch(() => {}).then(() => this.prune(target))
      await this.pruneTask
      return { path: target, allowedRoot: this.cacheDir, mime: 'audio/wav', ...metadata, cached: false }
    } finally { this.release(); await fs.rm(temporary, { force: true }) }
  }
  async prune(protectedFile) {
    const entries = await fs.readdir(this.cacheDir)
    const files = (await Promise.all(entries.filter((name) => /^[a-f0-9]{64}\.wav$/.test(name)).map(async (name) => { const file = path.join(this.cacheDir, name); return { file, ...await fs.stat(file) } }))).sort((a, b) => b.mtimeMs - a.mtimeMs)
    let total = 0
    for (const file of files) {
      total += file.size
      // The current and pre-scheduled next file remain leased even before Swift
      // opens them. Native keeps at most these two (each below 2 GiB).
      if (file.file !== protectedFile && !this.leases.has(file.file) && total > MAX_CACHE_BYTES) {
        await fs.rm(file.file, { force: true }); await fs.rm(`${file.file}.json`, { force: true })
      }
    }
  }
  dispose() { this.disposed = true; for (const job of this.jobs.values()) job.controller.abort() }
}

export class NativeAudioOutput {
  constructor({ dataDir, decoder, trackFile }) {
    this.dataDir = dataDir; this.decoder = decoder; this.trackFile = trackFile
    this.pending = new Map(); this.serial = 0; this.operation = 0; this.deviceId = 'default'; this.desiredVolume = 0.7; this.disposed = false
    this.transitionSettings = {}
    this.nextOperation = 0
  }
  async init() {
    if (!this.ready) this.ready = (async () => {
      if (process.platform !== 'darwin') throw failure('CoreAudio 输出仅适用于 macOS')
      const swift = await findExecutable('swiftc')
      if (!swift) throw failure('原生输出需要 Apple Command Line Tools（swiftc）')
      const hash = createHash('sha256').update(await fs.readFile(SOURCE)).update(process.arch).digest('hex').slice(0, 16)
      const folder = path.join(this.dataDir, 'native-v040'); await fs.mkdir(folder, { recursive: true, mode: 0o700 })
      this.binary = path.join(folder, `rhine-audio-${hash}`)
      if (!await exists(this.binary)) {
        const temporary = `${this.binary}.${randomUUID()}.tmp`
        try { await runProcess(swift, [SOURCE, '-O', '-o', temporary], { timeout: 120000 }); await fs.chmod(temporary, 0o700); await fs.rename(temporary, this.binary) }
        finally { await fs.rm(temporary, { force: true }) }
      }
    })()
    return this.ready
  }
  async start() {
    await this.init()
    if (this.disposed) throw failure('原生输出已关闭')
    if (this.process) return
    const child = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    this.process = child
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      for (let index; (index = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        try { const reply = JSON.parse(line); const request = this.pending.get(reply.id); if (request) { this.pending.delete(reply.id); clearTimeout(request.timer); reply.error ? request.reject(failure(reply.error, 422)) : request.resolve(reply.result) } } catch {}
      }
    })
    child.stderr.on('data', () => {})
    const failed = () => { if (this.process === child) this.process = null; for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(failure('CoreAudio 进程已退出，请重新选择输出')) }; this.pending.clear() }
    child.on('error', failed); child.on('exit', failed)
    child.stdin.on('error', () => {})
  }
  async send(command) {
    await this.start()
    return new Promise((resolve, reject) => {
      const id = ++this.serial
      const timer = setTimeout(() => { this.pending.delete(id); reject(failure('CoreAudio 响应超时')); this.process?.kill() }, 10000)
      this.pending.set(id, { resolve, reject, timer })
      this.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`)
    })
  }
  async devices() { return (await this.send({ action: 'devices' })).devices }
  observeState(state) {
    if (this.nextLease && state.boundarySerial > this.nextLease.boundarySerial && state.trackId === this.nextLease.trackId) {
      this.activeLease?.release?.(); this.activeLease = this.nextLease; this.nextLease = null
    }
    return state
  }
  invalidateNext() {
    ++this.nextOperation; this.nextPreparing?.abort(); this.nextPreparing = null
  }
  async cancelNext() {
    this.invalidateNext()
    const lease = this.nextLease
    // Reconcile an already crossed audio boundary before releasing either file.
    const state = this.observeState(await this.send({ action: 'cancelNext' }))
    if (this.nextLease === lease) { this.nextLease?.release?.(); this.nextLease = null }
    return state
  }
  async command(value) {
    const actions = new Set(['play', 'pause', 'stop', 'seek', 'volume', 'device', 'state', 'transition', 'prepareNext', 'cancelNext'])
    if (!actions.has(value.action)) throw failure('未知音频操作', 400)
    if (value.deviceId !== undefined && !/^(default|\d+)$/.test(value.deviceId)) throw failure('无效输出设备', 400)
    for (const key of ['position', 'volume']) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0)) throw failure(`无效 ${key}`, 400)
    if (value.volume !== undefined && value.volume > 1) throw failure('音量超出范围', 400)
    if (value.fadeEnabled !== undefined && typeof value.fadeEnabled !== 'boolean') throw failure('无效淡入淡出设置', 400)
    if (value.transitionMode !== undefined && !TRANSITION_MODES.has(value.transitionMode)) throw failure('无效歌曲衔接方式', 400)
    for (const key of ['trackId', 'afterTrackId']) if (value[key] !== undefined && (typeof value[key] !== 'string' || !/^[a-zA-Z0-9-]+$/.test(value[key]))) throw failure('无效歌曲 ID', 400)
    if (value.action === 'play' && value.trackId === undefined) throw failure('无效歌曲 ID', 400)
    const transitionSettings = value.transitionMode !== undefined ? { transitionMode: value.transitionMode }
      : value.fadeEnabled !== undefined ? { fadeEnabled: value.fadeEnabled } : {}
    if (value.action === 'transition') {
      if (!Object.keys(transitionSettings).length) throw failure('缺少歌曲衔接方式', 400)
      // A setting edit never aborts preparation or restarts the playing source.
      this.transitionSettings = transitionSettings
      await this.cancelNext()
      return this.observeState(await this.send({ action: 'transition', ...this.transitionSettings }))
    }
    if (value.action === 'volume') { this.desiredVolume = value.volume ?? this.desiredVolume; return this.send({ action: 'volume', volume: this.desiredVolume }) }
    if (value.action === 'state') return this.observeState(await this.send({ action: 'state' }))
    if (value.action === 'cancelNext') return this.cancelNext()
    if (value.action === 'prepareNext') {
      if (value.trackId === undefined) throw failure('缺少下一首歌曲 ID', 400)
      this.invalidateNext()
      const token = this.nextOperation, operation = this.operation
      const valid = () => token === this.nextOperation && operation === this.operation
      const current = this.observeState(await this.send({ action: 'state' }))
      if (!valid()) throw aborted()
      if (current.transitionMode !== 'gapless' || !current.playing) throw failure('当前未在无缝模式播放，无法预备下一首', 409)
      if (value.afterTrackId !== undefined && current.trackId !== value.afterTrackId) throw failure('当前歌曲已改变，已取消过期预备', 409)
      if (current.nextTrackId === value.trackId && this.nextLease?.trackId === value.trackId) return current
      this.observeState(await this.send({ action: 'cancelNext' }))
      if (!valid()) throw aborted()
      this.nextLease?.release?.(); this.nextLease = null
      const controller = new AbortController()
      this.nextPreparing = controller
      let decoded
      try {
        // The spare consumes integer frames in the engine's existing rate.
        // Explicit normalization avoids AVAudioPlayerNode's fractional SRC tail
        // varying by direction and inserting/doubling one boundary sample.
        decoded = await this.decoder.prepare(this.trackFile(value.trackId), { signal: controller.signal, retain: true, targetSampleRate: current.outputSampleRate })
        if (!valid()) throw aborted()
        const state = this.observeState(await this.send({ action: 'prepareNext', path: decoded.path, trackId: value.trackId, afterTrackId: current.trackId, afterBoundarySerial: current.boundarySerial }))
        if (!valid()) throw aborted()
        this.nextLease = { trackId: value.trackId, boundarySerial: current.boundarySerial ?? 0, release: decoded.release }
        decoded = null
        return this.observeState(state)
      } finally {
        decoded?.release?.()
        if (token === this.nextOperation) this.nextPreparing = null
      }
    }
    if (value.action === 'device') {
      await this.cancelNext()
      const previous = this.deviceId, requested = value.deviceId ?? 'default'
      this.deviceId = requested
      try { return await this.send({ action: 'device', deviceId: requested }) }
      catch (error) { if (this.deviceId === requested) this.deviceId = previous; throw error }
    }
    const operation = ++this.operation
    this.preparing?.abort(); this.preparing = null
    if (value.action === 'play') {
      // Capture the request before any await. A subsequent settings edit must
      // win even while we are waiting for cancellation/state acknowledgements.
      this.transitionSettings = transitionSettings
      if (value.deviceId !== undefined) this.deviceId = value.deviceId
      if (value.volume !== undefined) this.desiredVolume = value.volume
    }
    await this.cancelNext()
    if (operation !== this.operation) throw aborted()
    if (value.action === 'play') {
      if (typeof value.trackId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(value.trackId)) throw failure('无效歌曲 ID', 400)
      const controller = new AbortController(); this.preparing = controller
      // Silence the previous source before decoding or switching; no overlapping tracks.
      const current = await this.send({ action: 'state' })
      if (operation !== this.operation) throw aborted()
      if (current.trackId === value.trackId && value.position === undefined) {
        if (current.playing) return this.send({ action: 'volume', volume: this.desiredVolume, ...this.transitionSettings })
        if (current.currentTime < current.duration) return this.send({ action: 'play', volume: this.desiredVolume, ...this.transitionSettings })
      }
      const fadeOut = this.transitionSettings.transitionMode !== undefined
        ? this.transitionSettings.transitionMode !== 'gapless' : this.transitionSettings.fadeEnabled === true
      if (current.playing && fadeOut) {
        await this.send({ action: 'fadeOut' })
        await new Promise((resolve) => setTimeout(resolve, 450))
        if (operation !== this.operation) throw aborted()
      }
      await this.send({ action: 'stop' })
      this.activeLease?.release?.(); this.activeLease = null
      const decoded = await this.decoder.prepare(this.trackFile(value.trackId), { signal: controller.signal, retain: true })
      try {
        if (operation !== this.operation) throw aborted()
        this.preparing = null
        const state = await this.send({ action: 'play', path: decoded.path, trackId: value.trackId, position: value.position, deviceId: this.deviceId, volume: this.desiredVolume, ...this.transitionSettings })
        if (operation !== this.operation) throw aborted()
        this.activeLease = { trackId: value.trackId, release: decoded.release }
        return this.observeState(state)
      } catch (error) { decoded.release?.(); throw error }
    }
    const state = await this.send({ action: value.action, deviceId: value.deviceId, position: value.position })
    if (value.action === 'device') this.deviceId = state.deviceId
    if (value.action === 'stop') { this.activeLease?.release?.(); this.activeLease = null }
    return state
  }
  dispose() { this.disposed = true; ++this.operation; this.preparing?.abort(); this.invalidateNext(); this.process?.kill(); this.process = null; this.activeLease?.release?.(); this.nextLease?.release?.(); this.activeLease = this.nextLease = null }
}
