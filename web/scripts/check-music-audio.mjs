import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { AudioDecoder, NativeAudioOutput, runProcess, checkedSource, findExecutable } from './music-audio.mjs'
import { MusicLibraryStore } from './music-library.mjs'
import { createMusicServer } from './music-server.mjs'
import { createDsdFixture, DSD_RATES } from './fixtures/dsd.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const hash = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex')

// Read real WAV chunks (FFmpeg may add JUNK/LIST or use extensible fmt), without
// assuming a 44-byte header. The independent signal check catches mute output,
// reversed channels, and bit-order mistakes that metadata alone would miss.
function readPcm24Wav(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF')
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE')
  let format, data
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4)
    const chunk = buffer.subarray(offset + 8, offset + 8 + size)
    assert.equal(chunk.length, size, 'WAV chunk must be complete')
    if (buffer.toString('ascii', offset, offset + 4) === 'fmt ') format = chunk
    if (buffer.toString('ascii', offset, offset + 4) === 'data') data = chunk
    offset += 8 + size + size % 2
  }
  assert.ok(format && data?.length, 'decoded WAV has format and nonempty PCM')
  assert.ok([1, 0xfffe].includes(format.readUInt16LE(0)))
  if (format.readUInt16LE(0) === 0xfffe) assert.equal(format.readUInt16LE(24), 1, 'extensible WAV subtype is integer PCM')
  const channels = format.readUInt16LE(2), sampleRate = format.readUInt32LE(4)
  assert.equal(format.readUInt16LE(14), 24)
  assert.equal(format.readUInt16LE(12), channels * 3)
  assert.equal(data.length % (channels * 3), 0)
  return { data, channels, sampleRate, frames: data.length / (channels * 3) }
}

function assertStereoSignal(pcm, frequencies) {
  assert.equal(pcm.channels, 2)
  const start = Math.round(pcm.sampleRate * 0.01)
  const end = Math.min(pcm.frames, Math.round(pcm.sampleRate * 0.09))
  const amplitude = (channel, frequency) => {
    let sine = 0, cosine = 0
    for (let frame = start; frame < end; frame++) {
      const value = pcm.data.readIntLE((frame * pcm.channels + channel) * 3, 3) / 8388608
      const angle = 2 * Math.PI * frequency * frame / pcm.sampleRate
      sine += value * Math.sin(angle); cosine += value * Math.cos(angle)
    }
    return 2 * Math.hypot(sine, cosine) / (end - start)
  }
  for (let channel = 0; channel < pcm.channels; channel++) {
    const intended = amplitude(channel, frequencies[channel])
    const other = amplitude(channel, frequencies[1 - channel])
    assert.ok(intended > 0.1 && intended < 0.5, `channel ${channel} contains its audible test tone: ${intended}`)
    assert.ok(other < intended / 10, `channel ${channel} preserves stereo separation: ${other} / ${intended}`)
  }
}

test('FFmpeg real format decoding, immutable sources, bounded cache and HTTP security', async (t) => {
  const ffmpeg = await findExecutable('ffmpeg')
  assert.ok(ffmpeg, 'FFmpeg must be installed for the real decoder checks')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-audio-check-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const music = path.join(root, 'music'), dataDir = path.join(root, 'data')
  await fs.mkdir(music)
  const wav = path.join(music, '01 tone $literal.wav')
  await runProcess(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000', '-c:a', 'pcm_s24le', '-y', wav])
  const decoder = new AudioDecoder({ dataDir })
  t.after(() => decoder.dispose())
  const source = (file) => ({ path: file, allowedRoot: music })
  const fixtures = [[wav, 'pcm_s24le']]
  for (const [extension, codec, actual] of [['flac', 'flac', 'flac'], ['m4a', 'alac', 'alac'], ['aiff', 'pcm_s24be', 'pcm_s24be'], ['wv', 'wavpack', 'wavpack'], ['mp3', 'libmp3lame', 'mp3'], ['opus', 'libopus', 'opus'], ['aac', 'aac', 'aac']]) {
    const file = path.join(music, `tone.${extension}`)
    await runProcess(ffmpeg, ['-v', 'error', '-i', wav, '-c:a', codec, '-y', file]); fixtures.push([file, actual])
  }
  const float = path.join(music, 'float.wav')
  await runProcess(ffmpeg, ['-v', 'error', '-i', wav, '-c:a', 'pcm_f32le', '-y', float]); fixtures.push([float, 'pcm_f32le'])
  for (const [file, codec] of fixtures) await t.test(`decode ${path.extname(file)} ${codec} from actual media`, async () => {
    const before = await hash(file)
    const decoded = await decoder.prepare(source(file))
    assert.equal(decoded.codec, codec); assert.equal(decoded.sampleRate, 48000)
    assert.ok(decoded.bytes > 100000); assert.ok(decoded.duration >= 1.99)
    assert.equal(await hash(file), before, 'source bytes remain unchanged')
    if (['pcm_s24le', 'flac', 'alac', 'pcm_s24be', 'wavpack'].includes(codec)) {
      assert.equal(decoded.bitsPerSample, codec === 'wavpack' ? 32 : 24)
      const pcmHash = (file) => runProcess(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', 'pcm_s32le', '-f', 'hash', '-hash', 'sha256', '-'])
      assert.equal(await pcmHash(file), await pcmHash(decoded.path), 'lossless PCM hash is identical')
    }
    const cached = await decoder.prepare(source(file)); assert.equal(cached.cached, true); assert.equal(cached.path, decoded.path)
  })
  await t.test('renamed file reports actual codec; corrupt audio fails without publishing cache', async () => {
    const renamed = path.join(music, 'actually-mp3.flac'); await fs.copyFile(path.join(music, 'tone.mp3'), renamed)
    assert.equal((await decoder.prepare(source(renamed))).codec, 'mp3')
    const corrupt = path.join(music, 'broken.ape'); await fs.writeFile(corrupt, 'MAC invalid audio')
    await assert.rejects(decoder.prepare(source(corrupt)), /音频处理失败|没有可解码/)
    assert.equal((await fs.readdir(decoder.cacheDir)).some((name) => name.includes('.tmp.')), false)
  })
  const dsdFixtures = []
  for (const dsdRate of DSD_RATES) {
    let expectedPcmHash
    for (const [format, bitOrder] of [['dsf', 'lsb'], ['dsf', 'msb'], ['dff', 'msb']]) {
      await t.test(`DSD${dsdRate / 44100} ${format} ${bitOrder} decodes to 176.4 kHz/24-bit PCM with intact stereo and source`, async () => {
        const fixture = createDsdFixture({ format, bitOrder, dsdRate })
        const file = path.join(music, `dsd-${dsdRate}-${bitOrder}.${format}`)
        await fs.writeFile(file, fixture.buffer)
        dsdFixtures.push({ file, fixture })
        const decoded = await decoder.prepare(source(file))
        assert.equal(decoded.cached, false)
        assert.equal(decoded.codec, fixture.codec)
        assert.equal(decoded.conversion, 'dsd-to-pcm')
        assert.equal(decoded.sourceSampleRate, dsdRate)
        assert.equal(decoded.sourceBitsPerSample, 1)
        assert.equal(decoded.pcmCodec, 'pcm_s24le')
        assert.equal(decoded.bitsPerSample, 24)
        assert.equal(decoded.sampleRate, 176400)
        assert.equal(decoded.channels, fixture.channels)
        const pcm = readPcm24Wav(await fs.readFile(decoded.path))
        assert.equal(pcm.sampleRate, decoded.sampleRate)
        assert.ok(Math.abs(decoded.duration - pcm.frames / pcm.sampleRate) <= 1 / pcm.sampleRate, 'duration describes actual decoded frames')
        assert.ok(Math.abs(decoded.duration - fixture.duration) <= 1 / pcm.sampleRate, 'DSF block padding is excluded from duration')
        assertStereoSignal(pcm, fixture.frequencies)
        const pcmHash = createHash('sha256').update(pcm.data).digest('hex')
        expectedPcmHash ??= pcmHash
        assert.equal(pcmHash, expectedPcmHash, 'equivalent DSF bit orders and DFF preserve the same PCM samples')
        const cacheBefore = await hash(decoded.path)
        const cached = await decoder.prepare(source(file))
        assert.equal(cached.cached, true); assert.equal(cached.path, decoded.path)
        assert.equal(cached.conversion, 'dsd-to-pcm'); assert.equal(await hash(cached.path), cacheBefore)
        assert.deepEqual(await fs.readFile(file), fixture.buffer, 'playback conversion never rewrites the DSD source')
      })
    }
  }
  await t.test('DSD detection uses actual content and old conversion cache is invalidated', async () => {
    for (const { file, fixture } of dsdFixtures.filter(({ fixture }) => fixture.dsdRate === DSD_RATES[0])) {
      const disguised = path.join(music, `renamed-${fixture.format}-${fixture.bitOrder}.wav`)
      await fs.copyFile(file, disguised)
      const decoded = await decoder.prepare(source(disguised))
      assert.equal(decoded.codec, fixture.codec); assert.equal(decoded.conversion, 'dsd-to-pcm')
      assert.equal(decoded.sampleRate, 176400); assert.equal(decoded.bitsPerSample, 24)
      assertStereoSignal(readPcm24Wav(await fs.readFile(decoded.path)), fixture.frequencies)
      assert.deepEqual(await fs.readFile(disguised), fixture.buffer)
    }
    const { fixture } = dsdFixtures[0], file = path.join(music, 'old-cache.dsf')
    await fs.writeFile(file, fixture.buffer)
    const stat = await fs.stat(file)
    const realFile = await fs.realpath(file)
    const key = (version) => createHash('sha256').update(`${realFile}:${stat.size}:${stat.mtimeMs}:${version}`).digest('hex')
    const oldTarget = path.join(decoder.cacheDir, `${key('pcm-v3')}.wav`)
    await fs.copyFile(wav, oldTarget)
    await fs.writeFile(`${oldTarget}.json`, JSON.stringify({ codec: fixture.codec, duration: 2, sampleRate: 48000, bitsPerSample: 24 }))
    const decoded = await decoder.prepare(source(file))
    assert.equal(decoded.cached, false)
    assert.equal(decoded.path, path.join(decoder.cacheDir, `${key('pcm-v4-dsd17640024')}.wav`))
    assert.equal(decoded.sampleRate, 176400); assert.equal(decoded.conversion, 'dsd-to-pcm')
    assert.equal((await decoder.prepare(source(file))).cached, true)
    assert.deepEqual(await fs.readFile(file), fixture.buffer)
    await fs.rm(oldTarget); await fs.rm(`${oldTarget}.json`)
  })
  await t.test('truncated DSF/DFF fails without publishing incomplete PCM or changing the source', async () => {
    for (const format of ['dsf', 'dff']) {
      const fixture = createDsdFixture({ format })
      for (const length of [fixture.buffer.length - 10, Math.floor(fixture.buffer.length / 2)]) {
        const file = path.join(music, `truncated-${length}.${format}`)
        const truncated = fixture.buffer.subarray(0, length)
        await fs.writeFile(file, truncated)
        const before = (await fs.readdir(decoder.cacheDir)).sort()
        await assert.rejects(decoder.prepare(source(file)), /音频处理失败|没有可解码/)
        assert.deepEqual((await fs.readdir(decoder.cacheDir)).sort(), before, 'failed decode publishes no WAV or metadata')
        assert.deepEqual(await fs.readFile(file), truncated)
        await fs.rm(file)
      }
    }
    assert.equal((await fs.readdir(decoder.cacheDir)).some((name) => name.includes('.tmp.')), false)
  })
  await t.test('symlink escape and cancellation reject before decoding', async () => {
    const outside = path.join(root, 'outside.wav'); await fs.copyFile(wav, outside)
    const link = path.join(music, 'escape.wav'); await fs.symlink(outside, link)
    await assert.rejects(checkedSource(source(link)), /移出/)
    await assert.rejects(decoder.prepare(source(link)), /移出/)
    const playlist = path.join(music, 'playlist.ape')
    await fs.writeFile(playlist, "ffconcat version 1.0\nfile 'escape.wav'\n")
    await assert.rejects(decoder.prepare(source(playlist)), /音频处理失败/, 'secondary-path playlist disguises must be rejected by the demuxer whitelist')
    const controller = new AbortController(); controller.abort()
    await assert.rejects(decoder.prepare(source(wav), { signal: controller.signal }), { name: 'AbortError' })
  })
  await t.test('shared decode survives one consumer cancelling and leaves no temporary file', async () => {
    const fresh = path.join(music, 'fresh.wav'); await fs.copyFile(wav, fresh)
    const controller = new AbortController()
    const cancelled = decoder.prepare(source(fresh), { signal: controller.signal })
    const survivor = decoder.prepare(source(fresh))
    const rejected = assert.rejects(cancelled, { name: 'AbortError' })
    await delay(10); controller.abort(); await rejected
    assert.ok((await survivor).bytes > 44)
  })
  await t.test('APE official FFmpeg regression sample, when explicitly supplied', async (t) => {
    const ape = process.env.RHINE_TEST_APE
    if (!ape) return t.skip('Set RHINE_TEST_APE to the downloaded official FFmpeg luckynight.ape fixture')
    assert.equal(createHash('md5').update(await fs.readFile(ape)).digest('hex'), 'ab078cadd6367ab132124cbc0ecb8005')
    const decoded = await decoder.prepare({ path: ape, allowedRoot: path.dirname(ape) })
    assert.equal(decoded.codec, 'ape'); assert.equal(decoded.bitsPerSample, 16); assert.equal(decoded.sampleRate, 44100); assert.equal(decoded.channels, 2)
    assert.ok(decoded.duration >= 59 && decoded.duration <= 61)
  })
  await t.test('missing ffprobe is unavailable and completed cache is capped even for fresh entries', async () => {
    const missing = new AudioDecoder({ dataDir, ffmpeg, ffprobe: path.join(root, 'missing-ffprobe') })
    await missing.init(); assert.equal(missing.ffmpeg, null); assert.match(missing.error, /ffprobe/)
    const cacheRoot = path.join(root, 'cache-limit')
    const bounded = new AudioDecoder({ dataDir: cacheRoot }); await bounded.init()
    for (let i = 1; i <= 3; i++) {
      const file = path.join(bounded.cacheDir, `${String(i).padStart(64, '0')}.wav`)
      const handle = await fs.open(file, 'w'); await handle.truncate(1536 * 1024 ** 2); await handle.close()
    }
    await bounded.prune(path.join(bounded.cacheDir, `${'3'.padStart(64, '0')}.wav`))
    const sizes = await Promise.all((await fs.readdir(bounded.cacheDir)).filter((file) => file.endsWith('.wav')).map(async (file) => (await fs.stat(path.join(bounded.cacheDir, file))).size))
    assert.ok(sizes.reduce((total, size) => total + size, 0) <= 4 * 1024 ** 3)
    bounded.dispose(); missing.dispose()
  })
  const store = await new MusicLibraryStore({ dataDir, defaultRoots: [music] }).init()
  await store.scan()
  const app = await createMusicServer({ store, autoScan: false })
  app.server.listen(0, '127.0.0.1'); await new Promise((resolve) => app.server.once('listening', resolve))
  t.after(() => { app.server.closeAllConnections(); return new Promise((resolve) => app.server.close(resolve)) })
  const base = `http://127.0.0.1:${app.server.address().port}`
  const tracks = store.snapshot().albums.flatMap((album) => album.tracks)
  const track = tracks.find((item) => item.relativePath.endsWith('.m4a'))
  await t.test('HTTP PCM preparation and seek ranges, no paths in JSON, wrong origin/host rejected', async () => {
    const result = await fetch(`${base}/api/audio/prepare/${track.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(result.status, 200); const prepared = await result.json()
    assert.equal(prepared.path, undefined); assert.equal(prepared.allowedRoot, undefined)
    const ranged = await fetch(base + prepared.audioUrl, { headers: { Range: 'bytes=0-11' } })
    assert.equal(ranged.status, 206); assert.equal((await ranged.text()).slice(0, 4), 'RIFF')
    assert.equal((await fetch(base + prepared.audioUrl, { headers: { Range: 'bytes=999999999-' } })).status, 416)
    assert.equal((await fetch(`${base}/api/output/state`, { headers: { Origin: 'https://evil.invalid' } })).status, 403)
    const badHost = await new Promise((resolve, reject) => { const request = http.get(`${base}/api/audio/capabilities`, { headers: { Host: 'evil.invalid' } }, (response) => { response.resume(); resolve(response.statusCode) }); request.on('error', reject) })
    assert.equal(badHost, 403)
    assert.equal((await fetch(`${base}/api/audio/prepare/missing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404)
    assert.equal((await fetch(`${base}/api/output/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'play', path: '/etc/passwd' }) })).status, 400)
  })
  await t.test('DSF/DFF HTTP prepare exposes conversion metadata, decoded WAV ranges, and unchanged raw DSD', async () => {
    const capabilities = await (await fetch(`${base}/api/audio/capabilities`)).json()
    assert.equal(capabilities.dsdPlayback, 'pcm')
    for (const format of ['dsf', 'dff']) {
      const { file, fixture } = dsdFixtures.find((item) => item.fixture.format === format)
      const dsdTrack = tracks.find((item) => item.relativePath === path.basename(file))
      assert.ok(dsdTrack, `${format} is indexed`)
      const result = await fetch(`${base}/api/audio/prepare/${dsdTrack.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      assert.equal(result.status, 200)
      const prepared = await result.json()
      assert.equal(prepared.path, undefined); assert.equal(prepared.allowedRoot, undefined)
      assert.equal(prepared.conversion, 'dsd-to-pcm'); assert.equal(prepared.codec, fixture.codec)
      assert.equal(prepared.sourceSampleRate, fixture.dsdRate); assert.equal(prepared.sourceBitsPerSample, 1)
      assert.equal(prepared.sampleRate, 176400); assert.equal(prepared.bitsPerSample, 24)
      assert.equal(prepared.pcmCodec, 'pcm_s24le'); assert.equal(prepared.channels, 2)
      const ranged = await fetch(base + prepared.audioUrl, { headers: { Range: 'bytes=0-11' } })
      assert.equal(ranged.status, 206)
      assert.equal(ranged.headers.get('content-type'), 'audio/wav')
      assert.equal(ranged.headers.get('content-range'), `bytes 0-11/${prepared.bytes}`)
      const header = Buffer.from(await ranged.arrayBuffer())
      assert.equal(header.toString('ascii', 0, 4), 'RIFF'); assert.equal(header.toString('ascii', 8, 12), 'WAVE')
      const decoded = await fetch(base + prepared.audioUrl)
      assert.equal(decoded.status, 200)
      assertStereoSignal(readPcm24Wav(Buffer.from(await decoded.arrayBuffer())), fixture.frequencies)
      const raw = await fetch(`${base}/api/audio/${dsdTrack.id}`)
      assert.equal(raw.status, 200)
      assert.deepEqual(Buffer.from(await raw.arrayBuffer()), fixture.buffer, 'raw source endpoint still serves original DSD bytes')
      assert.deepEqual(await fs.readFile(file), fixture.buffer)
    }
  })
  if (process.platform === 'darwin') await t.test('real CoreAudio device selection, progress, pause, seek, resume, end and rapid cancellation at zero gain', async () => {
    const output = new NativeAudioOutput({ dataDir, decoder, trackFile: () => source(wav) }); t.after(() => output.dispose())
    const devices = await output.devices(); assert.ok(devices.length)
    const device = devices.find((item) => /MacBook|Built-in/i.test(item.name)) ?? devices[0]
    assert.equal((await output.command({ action: 'device', deviceId: device.id })).deviceId, device.id)
    let state = await output.command({ action: 'play', trackId: 'generated', volume: 0, fadeEnabled: false })
    assert.equal(state.playing, true); assert.equal(state.deviceId, device.id)
    await delay(160); state = await output.command({ action: 'pause' }); const paused = state.currentTime
    assert.ok(paused > 0); assert.equal(state.playing, false)
    await delay(100); assert.equal((await output.command({ action: 'state' })).currentTime, paused)
    state = await output.command({ action: 'seek', position: 1.25 }); assert.equal(state.playing, false); assert.equal(state.currentTime, 1.25)
    state = await output.command({ action: 'play', trackId: 'generated', volume: 0 }); assert.equal(state.playing, true); assert.ok(state.currentTime >= 1.25)
    await output.command({ action: 'seek', position: 1.9 }); await delay(500)
    state = await output.command({ action: 'state' }); assert.equal(state.playing, false); assert.ok(state.endedSerial >= 1)
    await output.command({ action: 'play', trackId: 'generated', volume: 0 })
    const endedBefore = state.endedSerial
    state = await output.command({ action: 'seek', position: 2 })
    assert.equal(state.playing, false); assert.ok(state.endedSerial > endedBefore, 'seeking to the exact end reports a completed track')
    const pending = output.command({ action: 'play', trackId: 'old', volume: 0 }); const rejected = assert.rejects(pending, { name: 'AbortError' })
    await output.command({ action: 'stop' }); await rejected; assert.equal((await output.command({ action: 'state' })).playing, false)
    await assert.rejects(output.command({ action: 'device', deviceId: '999999999' }), /设备/)
    for (const format of ['dsf', 'dff']) {
      const fixture = createDsdFixture({ format, duration: 0.6 })
      const file = path.join(music, `native-playback.${format}`)
      await fs.writeFile(file, fixture.buffer)
      output.trackFile = () => source(file)
      const endedBefore = (await output.command({ action: 'state' })).endedSerial
      state = await output.command({ action: 'play', trackId: `native-${format}`, volume: 0, fadeEnabled: false })
      assert.equal(state.playing, true); assert.equal(state.deviceId, device.id)
      assert.ok(Math.abs(state.duration - fixture.duration) < 0.001)
      await delay(100)
      state = await output.command({ action: 'pause' })
      assert.ok(state.currentTime > 0); assert.equal(state.playing, false)
      state = await output.command({ action: 'play', trackId: `native-${format}`, volume: 0, fadeEnabled: false })
      assert.equal(state.playing, true)
      await delay(750)
      state = await output.command({ action: 'state' })
      assert.equal(state.playing, false); assert.ok(state.endedSerial > endedBefore)
      assert.deepEqual(await fs.readFile(file), fixture.buffer)
    }
  })
})

test('native pending decode uses the latest device and volume; repeated playing track keeps its position', async () => {
  let finishDecode, decodeSignal
  const decoder = { prepare: async (_source, { signal }) => { decodeSignal = signal; return new Promise((resolve) => { finishDecode = () => resolve({ path: '/isolated/mock.wav' }) }) } }
  const output = new NativeAudioOutput({ dataDir: '/unused', decoder, trackFile: () => ({}) })
  const calls = []
  const state = { trackId: '', playing: false, duration: 10, currentTime: 0, deviceId: 'default', endedSerial: 0 }
  output.send = async (command) => {
    calls.push(command)
    if (command.action === 'play') { state.trackId = command.trackId ?? state.trackId; state.playing = true }
    if (command.action === 'stop') { state.trackId = ''; state.playing = false }
    if (command.action === 'device') state.deviceId = command.deviceId
    return { ...state }
  }
  const playing = output.command({ action: 'play', trackId: 'test', volume: 0.7, deviceId: 'default' })
  while (!finishDecode) await delay(0)
  await output.command({ action: 'volume', volume: 0 })
  await output.command({ action: 'device', deviceId: '42' })
  assert.equal(decodeSignal.aborted, false, 'device changes must preserve pending decoding')
  finishDecode(); await playing
  const actualPlay = calls.findLast((command) => command.action === 'play')
  assert.equal(actualPlay.volume, 0, 'muting during decoding must never be undone')
  assert.equal(actualPlay.deviceId, '42', 'decoded song starts on the latest selected device')
  state.currentTime = 5
  const previousPlayCount = calls.filter((command) => command.action === 'play').length
  assert.equal((await output.command({ action: 'play', trackId: 'test', volume: 0 })).currentTime, 5)
  assert.equal(calls.filter((command) => command.action === 'play').length, previousPlayCount)
  output.dispose()
})

function nativeTransitionFixture(decoder = { prepare: async () => ({ path: '/isolated/next.wav' }) }) {
  const output = new NativeAudioOutput({ dataDir: '/unused', decoder, trackFile: () => ({}) })
  const calls = []
  const state = { trackId: 'current', playing: true, duration: 20, currentTime: 5, deviceId: 'default', endedSerial: 0, transitionMode: 'fade-in-out' }
  output.send = async command => {
    calls.push(command)
    if (command.transitionMode !== undefined) state.transitionMode = command.transitionMode
    else if (command.fadeEnabled !== undefined) state.transitionMode = command.fadeEnabled ? 'fade-in-out' : 'gapless'
    if (command.action === 'stop') { state.trackId = ''; state.playing = false }
    if (command.action === 'play') { state.trackId = command.trackId ?? state.trackId; state.playing = true }
    return { ...state }
  }
  return { output, calls, state }
}

test('native transition modes split fade-out from fade-in and preserve legacy protocol precedence', async () => {
  for (const [fields, fadeOut, forwarded] of [
    [{ transitionMode: 'fade-out' }, true, { transitionMode: 'fade-out' }],
    [{ transitionMode: 'fade-in-out' }, true, { transitionMode: 'fade-in-out' }],
    [{ transitionMode: 'gapless' }, false, { transitionMode: 'gapless' }],
    [{ transitionMode: 'gapless', fadeEnabled: true }, false, { transitionMode: 'gapless' }],
    [{ transitionMode: 'fade-out', fadeEnabled: false }, true, { transitionMode: 'fade-out' }],
    [{ fadeEnabled: false }, false, { fadeEnabled: false }],
    [{ fadeEnabled: true }, true, { fadeEnabled: true }],
    [{}, false, {}],
  ]) {
    const { output, calls } = nativeTransitionFixture()
    await output.command({ action: 'play', trackId: 'next', ...fields })
    assert.equal(calls.some(command => command.action === 'fadeOut'), fadeOut, JSON.stringify(fields))
    const play = calls.findLast(command => command.action === 'play')
    const actual = Object.fromEntries(['transitionMode', 'fadeEnabled'].filter(key => Object.hasOwn(play, key)).map(key => [key, play[key]]))
    assert.deepEqual(actual, forwarded, 'New modes take precedence; absent legacy fields remain absent for Swift to retain its previous setting')
    assert.ok(calls.findIndex(command => command.action === 'stop') < calls.indexOf(play), 'No transition mode overlaps the outgoing and incoming source')
    output.dispose()
  }
})

test('native transition validation rejects malformed values before output and live edits preserve pending decoding', async () => {
  let finishDecode, decodeSignal
  const decoder = { prepare: async (_descriptor, { signal }) => {
    decodeSignal = signal
    return new Promise(resolve => { finishDecode = () => resolve({ path: '/isolated/ready.wav' }) })
  } }
  const { output, calls, state } = nativeTransitionFixture(decoder)
  for (const transitionMode of ['invalid', '', false, null, 2, {}])
    await assert.rejects(output.command({ action: 'transition', transitionMode }), error => error.status === 400)
  await assert.rejects(output.command({ action: 'transition' }), error => error.status === 400)
  await assert.rejects(output.command({ action: 'play', trackId: 'next', fadeEnabled: 'false' }), error => error.status === 400)
  assert.equal(calls.length, 0)
  state.playing = false
  const pending = output.command({ action: 'play', trackId: 'next', transitionMode: 'fade-in-out' })
  while (!finishDecode) await delay(0)
  const operation = output.operation
  await output.command({ action: 'transition', transitionMode: 'fade-out' })
  await output.command({ action: 'transition', transitionMode: 'gapless' })
  assert.equal(output.operation, operation, 'Changing the mode does not restart the transport')
  assert.equal(decodeSignal.aborted, false)
  finishDecode(); await pending
  assert.equal(calls.findLast(command => command.action === 'play').transitionMode, 'gapless', 'The final play uses the newest setting after slow decoding')
  assert.equal(state.trackId, 'next')
  const oldPosition = state.currentTime
  await output.command({ action: 'play', trackId: 'next', transitionMode: 'fade-out' })
  assert.equal(calls.at(-1).action, 'volume', 'Reselecting the playing song does not schedule it again')
  assert.equal(state.transitionMode, 'fade-out')
  assert.equal(state.currentTime, oldPosition)
  output.dispose()
})

test('native transition changes during fade-out survive the wait and cancellation cannot start the obsolete song', async () => {
  const changed = nativeTransitionFixture()
  const pending = changed.output.command({ action: 'play', trackId: 'next', transitionMode: 'fade-in-out' })
  while (!changed.calls.some(command => command.action === 'fadeOut')) await delay(0)
  await changed.output.command({ action: 'transition', transitionMode: 'fade-out' })
  await pending
  assert.equal(changed.calls.findLast(command => command.action === 'play').transitionMode, 'fade-out')
  changed.output.dispose()
  const cancelled = nativeTransitionFixture()
  const old = cancelled.output.command({ action: 'play', trackId: 'discarded', transitionMode: 'fade-out' })
  const rejected = assert.rejects(old, { name: 'AbortError' })
  while (!cancelled.calls.some(command => command.action === 'fadeOut')) await delay(0)
  await cancelled.output.command({ action: 'stop' }); await rejected
  assert.equal(cancelled.calls.some(command => command.action === 'play'), false)
  cancelled.output.dispose()
})

test('production Swift transition commands cancel only active fade-in without resetting transport', { skip: process.platform !== 'darwin' }, async t => {
  const swift = await findExecutable('swiftc')
  assert.ok(swift)
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-transition-check-'))
  t.after(() => fs.rm(folder, { recursive: true, force: true }))
  const source = await fs.readFile(new URL('../native/RhineAudio.swift', import.meta.url), 'utf8')
  const declarations = source.split('\nlet output = Output()')[0]
  assert.notEqual(declarations, source, 'The production bridge entry point is located')
  const file = path.join(folder, 'TransitionCheck.swift'), binary = path.join(folder, 'transition-check')
  await fs.writeFile(file, declarations + `
let subject = Output()
func check(_ condition: @autoclosure () -> Bool, _ message: String) { if !condition() { fatalError(message) } }
check(subject.transitionMode == .fadeInOut, "Default remains fade-in-out")
subject.desiredVolume = 0.6
subject.trackId = "retained"; subject.base = 17
for mode in ["fade-out", "gapless"] {
    subject.player.volume = 0
    subject.fade(to: subject.desiredVolume)
    check(subject.fadingIn, "The actual fade has started")
    let generation = subject.generation
    let result = try subject.command(["action": "transition", "transitionMode": mode])
    check(result["transitionMode"] as? String == mode, "State reports the accepted mode")
    check(subject.player.volume == subject.desiredVolume, "Removing fade-in restores desired volume")
    check(!subject.fadingIn, "The old envelope is cancelled")
    check(subject.generation == generation && subject.trackId == "retained" && subject.base == 17, "Mode edits retain the transport")
    RunLoop.main.run(until: Date().addingTimeInterval(0.06))
    check(subject.player.volume == subject.desiredVolume, "Stale timer callbacks cannot lower the restored gain")
}
_ = try subject.command(["action": "transition", "transitionMode": "fade-out", "fadeEnabled": true])
check(subject.transitionMode == .fadeOut, "New mode wins over legacy flag")
_ = try subject.command(["action": "transition", "fadeEnabled": false])
check(subject.transitionMode == .gapless, "Legacy false disables both envelopes")
_ = try subject.command(["action": "state"])
check(subject.transitionMode == .gapless, "Omitted fields retain the previous choice")
_ = try subject.command(["action": "transition", "fadeEnabled": true])
check(subject.transitionMode == .fadeInOut, "Legacy true restores both envelopes")
subject.player.volume = subject.desiredVolume
subject.fade(to: 0)
let outgoingFade = subject.fadeGeneration
_ = try subject.command(["action": "transition", "transitionMode": "fade-out"])
check(subject.fadeGeneration == outgoingFade, "Selecting fade-out does not cancel an outgoing fade")
for invalid: [String: Any] in [["action": "transition", "transitionMode": "wrong"], ["action": "transition", "fadeEnabled": "false"], ["action": "transition"]] {
    var rejected = false
    do { _ = try subject.command(invalid) } catch { rejected = true }
    check(rejected, "Invalid bridge values are rejected")
}
subject.cancelFade()
print("Swift transition parsing, live envelope cancellation, stale callbacks and transport retention passed")
`)
  await runProcess(swift, [file, '-o', binary], { timeout: 120000 })
  assert.match(await runProcess(binary, []), /Swift transition parsing/)
})
