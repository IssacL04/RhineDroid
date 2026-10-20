import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { AudioDecoder, NativeAudioOutput, runProcess, findExecutable } from './music-audio.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function floatWav(rate, duration, amplitude, startFrame = 0, ramp = false, channels = 2) {
  const frames = Math.round(rate * duration), buffer = Buffer.alloc(44 + frames * channels * 4)
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(3, 20); buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * channels * 4, 28); buffer.writeUInt16LE(channels * 4, 32); buffer.writeUInt16LE(32, 34)
  buffer.write('data', 36); buffer.writeUInt32LE(frames * channels * 4, 40)
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++)
    buffer.writeFloatLE(ramp ? 0.1 + (startFrame + frame) / rate * 0.2 + channel * 0.05 : amplitude + channel * 0.025, 44 + frame * channels * 4 + channel * 4)
  return buffer
}

// This test renders the production Output, not a mock scheduler, through Apple's
// offline mixer. It examines every output sample around and across the boundary.
test('production CoreAudio renders exact contiguous PCM, mixed rates, queue cancellation and transport boundaries', { skip: process.platform !== 'darwin' }, async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-gapless-pcm-'))
  t.after(() => fs.rm(folder, { recursive: true, force: true }))
  for (const rate of [44100, 48000]) for (const [name, amplitude] of [['a', 0.25], ['b', 0.5], ['c', 0.75]])
    await fs.writeFile(path.join(folder, `${name}${rate}.wav`), floatWav(rate, 0.5, amplitude))
  for (const [name, start] of [['ramp-a', 0], ['ramp-b', 24000]])
    await fs.writeFile(path.join(folder, `${name}.wav`), floatWav(48000, 0.5, 0, start, true))
  await fs.writeFile(path.join(folder, 'mono48000.wav'), floatWav(48000, 0.5, 0.25, 0, false, 1))
  await fs.writeFile(path.join(folder, 'surround48000.wav'), floatWav(48000, 0.5, 0.25, 0, false, 6))
  await fs.writeFile(path.join(folder, 'fractional44100.wav'), floatWav(44100, 22056 / 44100, 0.5))
  await fs.writeFile(path.join(folder, 'fractional48000.wav'), floatWav(48000, 24001 / 48000, 0.5))
  const decoder = new AudioDecoder({ dataDir: path.join(folder, 'data') })
  t.after(() => decoder.dispose())
  for (const [name, targetSampleRate] of [['b44100', 48000], ['b48000', 44100], ['fractional44100', 48000], ['fractional48000', 44100]]) {
    const source = { path: path.join(folder, `${name}.wav`), allowedRoot: folder }
    const original = await decoder.prepare(source)
    const normalized = await decoder.prepare(source, { targetSampleRate })
    assert.equal(normalized.sampleRate, targetSampleRate); assert.equal(normalized.pcmCodec, 'pcm_f32le')
    assert.notEqual(normalized.path, original.path, 'Playback-rate normalization has its own cache variant')
    await fs.copyFile(normalized.path, path.join(folder, `normalized-${name}-${targetSampleRate}.wav`))
  }
  const source = await fs.readFile(new URL('../native/RhineAudio.swift', import.meta.url), 'utf8')
  const declarations = source.split('\nlet output = Output()')[0]
  assert.notEqual(declarations, source)
  const swift = `${declarations}
let folder = CommandLine.arguments[1]
func check(_ test: @autoclosure () -> Bool, _ message: String) { if !test() { fatalError(message) } }
final class Render {
    let output = Output()
    let format: AVAudioFormat
    let buffer: AVAudioPCMBuffer
    var samples = [[Float](), [Float]()]
    init(_ first: String) throws {
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: folder + "/" + first + ".wav"))
        output.file = file; output.trackId = "first"; output.transitionMode = .gapless; output.desiredVolume = 1
        output.connectPlayers(for: file)
        format = output.player.outputFormat(forBus: 0)
        try output.engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 512)
        buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 512)!
        try output.schedule(at: 0, play: true)
    }
    func render(_ count: Int) throws {
        var remaining = count
        while remaining > 0 {
            let count = AVAudioFrameCount(min(remaining, 512))
            let status = try output.engine.renderOffline(count, to: buffer)
            check(status == .success, "Offline engine must render real samples")
            for channel in 0..<2 { samples[channel].append(contentsOf: UnsafeBufferPointer(start: buffer.floatChannelData![channel], count: Int(count))) }
            remaining -= Int(count)
        }
    }
    func prepare(_ name: String, id: String = "second") throws {
        let normalized = folder + "/normalized-" + name + "-\\(Int(format.sampleRate)).wav"
        let path = FileManager.default.fileExists(atPath: normalized) ? normalized : folder + "/" + name + ".wav"
        _ = try output.command(["action": "prepareNext", "trackId": id, "afterTrackId": output.trackId, "path": path])
    }
    func finishCallbacks() { RunLoop.main.run(until: Date().addingTimeInterval(0.04)) }
    deinit { _ = try? output.command(["action": "stop"]) }
}
for (firstRate, secondRate) in [(48000, 48000), (44100, 48000), (48000, 44100)] {
    let render = try Render("a\\(firstRate)"), output = render.output, half = firstRate / 2
    let generation = output.generation
    try render.render(1024); try render.prepare("b\\(secondRate)")
    try render.render(half + 128 - 1024)
    let middle = output.state()
    check(middle["trackId"] as? String == "second", "State follows the actual audio-clock boundary")
    check(output.boundarySerial == 1 && output.endedSerial == 0 && output.playing, "An automatic boundary is not a queue end")
    check(abs(output.position - 128 / Double(firstRate)) < 1 / Double(firstRate), "Position uses the new node timeline at its own rate")
    try render.prepare("c\\(firstRate)", id: "third")
    try render.render(half * 3 + 512 - render.samples[0].count)
    _ = output.state()
    render.finishCallbacks()
    check(output.trackId == "third" && output.boundarySerial == 2, "Three files use successive native clock boundaries: \\(output.state())")
    // dataPlayedBack follows device presentation, which offline rendering has
    // no wall-clock equivalent for. Final endedSerial is checked on real output.
    check(output.generation == generation, "Neither boundary restarts the transport")
    for channel in 0..<2 { for frame in 0..<(half * 3) {
        let value = render.samples[channel][frame]
        let section = frame / half, expected = Float(section + 1) * 0.25 + Float(channel) * 0.025
        let allowance: Float = section == 1 && firstRate != secondRate ? 0.08 : 0.000001
        check(abs(value - expected) < allowance, "No missing, duplicated, silent or overlapping output at frame \\(frame), section \\(section), rate \\(firstRate) -> \\(secondRate): \\(value)")
    } }
    check(render.samples[0].suffix(256).allSatisfy { abs($0) < 0.000001 }, "There are no extra samples beyond the final duration")
    print("PCM seam verified: \\(firstRate) -> \\(secondRate) -> \\(firstRate), \\(half * 3) continuous frames")
}
do {
    let render = try Render("ramp-a")
    try render.render(1024); try render.prepare("ramp-b")
    try render.render(48000 - 1024)
    for channel in 0..<2 { for frame in 0..<48000 {
        let expected = Float(0.1 + Double(frame) / 48000 * 0.2 + Double(channel) * 0.05)
        check(abs(render.samples[channel][frame] - expected) < 0.000001, "Split waveform is identical sample-for-sample to the original ramp")
    } }
    print("Split stereo waveform: all 96000 samples exactly match, with no added envelope")
}
for (first, next, nextIsMono) in [("mono48000", "b48000", false), ("a48000", "mono48000", true)] {
    let render = try Render(first)
    try render.render(1024); try render.prepare(next); try render.render(48000 - 1024)
    for channel in 0..<2 {
        let expected: Float = nextIsMono ? 0.25 : 0.5 + Float(channel) * 0.025
        check(render.samples[channel][24000..<48000].allSatisfy { abs($0 - expected) < 0.000001 }, "Mono/stereo transitions retain both output channels")
    }
}
for (rate, next) in [(48000, "fractional44100"), (44100, "fractional48000")] {
    let render = try Render("a\\(rate)"), output = render.output, half = rate / 2
    let normalized = try AVAudioFile(forReading: URL(fileURLWithPath: folder + "/normalized-" + next + "-\\(rate).wav"))
    let convertedFrames = Int(normalized.length)
    try render.render(1024); try render.prepare(next)
    try render.render(half + 128 - 1024); _ = output.state()
    try render.prepare("c\\(rate)", id: "third")
    let boundary = half + convertedFrames
    try render.render(boundary + half - render.samples[0].count)
    for channel in 0..<2 {
        check(render.samples[channel][half..<boundary].allSatisfy { $0 > 0.35 && $0 < 0.65 }, "Fractional rate conversion has no inserted silent sample or overlap")
        let expected = 0.75 + Float(channel) * 0.025
        if let bad = (boundary..<(boundary + half)).first(where: { abs(render.samples[channel][$0] - expected) >= 0.000001 }) {
            fatalError("Next source starts at the actual whole-frame converter boundary: rate \\(rate), channel \\(channel), frame \\(bad), value \\(render.samples[channel][bad]), expected \\(expected)")
        }
    }
}
do {
    let render = try Render("a48000")
    try render.render(1024)
    var rejected = false
    do { try render.prepare("surround48000") } catch { rejected = true }
    check(rejected && render.output.next == nil && render.output.playing, "A larger channel layout is reported instead of silently truncating channels")
}
do {
    let render = try Render("a48000")
    try render.render(1024)
    var rejected = false
    do { _ = try render.output.command(["action": "prepareNext", "trackId": "second", "path": folder + "/b44100.wav"]) } catch { rejected = true }
    check(rejected && render.output.next == nil, "Unnormalized input cannot silently use an imprecise internal SRC boundary")
}
for action in ["cancelNext", "transition"] {
    let render = try Render("a48000"), output = render.output
    try render.render(1024); try render.prepare("b44100")
    let generation = output.generation, offset = output.position
    _ = try output.command(action == "transition" ? ["action": action, "transitionMode": "fade-out"] : ["action": action])
    check(output.next == nil && output.generation == generation && output.position == offset, "Cancelling next does not restart current")
    try render.render(24000 + 512 - 1024); render.finishCallbacks()
    check(output.trackId == "first" && output.boundarySerial == 0, "Cancelled next never starts")
    check(render.samples[0].prefix(24000).allSatisfy { abs($0 - 0.25) < 0.000001 }, "Cancellation does not interrupt current PCM")
    check(render.samples[0].suffix(512).allSatisfy { abs($0) < 0.000001 }, "Cancelled source contributes no PCM")
}
do {
    let render = try Render("a48000"), output = render.output
    try render.render(1024); try render.prepare("b48000")
    try render.render(24000 + 128 - 1024)
    _ = try output.command(["action": "cancelNext"])
    check(output.trackId == "second" && output.playing, "Cancellation after a boundary cannot stop the promoted source")
    try render.render(256)
    check(render.samples[0].suffix(256).allSatisfy { abs($0 - 0.5) < 0.000001 }, "Promoted PCM is uninterrupted")
}
for action in ["pause", "seek", "stop"] {
    let render = try Render("a48000"), output = render.output
    try render.render(1024); try render.prepare("b48000")
    _ = try output.command(action == "seek" ? ["action": action, "position": 0.25] : ["action": action])
    check(output.next == nil, "Transport edits clear the scheduled spare")
    if action != "stop" { try render.render(24000); render.finishCallbacks() }
    check(output.boundarySerial == 0, "Invalidated queued callbacks cannot advance a track")
    if action == "pause" { check(!output.playing && abs(output.position - 1024 / 48000.0) < 0.000001, "Pause retains position") }
}
do {
    let render = try Render("a48000"), output = render.output
    try render.render(23600)
    var rejected = false
    do { try render.prepare("b48000") } catch { rejected = true }
    check(rejected && output.next == nil && output.trackId == "first", "Late preparation is reported, never started late as gapless")
}
print("Production gapless PCM, channel layouts, cancellation and exact-position checks passed")
`
  const file = path.join(folder, 'GaplessCheck.swift'), binary = path.join(folder, 'gapless-check')
  await fs.writeFile(file, swift)
  await runProcess(await findExecutable('swiftc'), [file, '-o', binary], { timeout: 120000 })
  const output = await runProcess(binary, [folder])
  assert.match(output, /Production gapless PCM/)
  t.diagnostic(output.trim())
})

function bridgeFixture(decoder) {
  const output = new NativeAudioOutput({ dataDir: '/unused', decoder, trackFile: id => ({ id }) })
  const calls = [], state = { trackId: 'first', transitionMode: 'gapless', playing: true, currentTime: 0.2, duration: 10, endedSerial: 0, boundarySerial: 0, nextTrackId: '' }
  output.send = async command => {
    calls.push(command)
    if (command.action === 'cancelNext') state.nextTrackId = ''
    if (command.action === 'prepareNext') state.nextTrackId = command.trackId
    if (command.action === 'stop') { state.trackId = ''; state.playing = false }
    if (command.action === 'pause') state.playing = false
    if (command.action === 'play') { state.trackId = command.trackId ?? state.trackId; state.playing = true }
    if (command.action === 'transition') state.transitionMode = command.transitionMode
    return { ...state }
  }
  return { output, calls, state }
}

test('native predecode cancellation prevents stale scheduling across every transport and mode edit', async () => {
  for (const command of [{ action: 'cancelNext' }, { action: 'pause' }, { action: 'seek', position: 2 }, { action: 'stop' }, { action: 'play', trackId: 'replacement', transitionMode: 'gapless', volume: 0 }, { action: 'device', deviceId: '42' }, { action: 'transition', transitionMode: 'fade-out' }]) {
    let ready, releaseCount = 0
    const decoder = { prepare: async (source, { signal }) => {
      if (source.id !== 'second') return { path: '/isolated/replacement.wav', release() {} }
      return new Promise(resolve => { ready = () => resolve({ path: '/isolated/next.wav', release() { releaseCount++ } }) })
    } }
    const { output, calls } = bridgeFixture(decoder)
    const pending = output.command({ action: 'prepareNext', trackId: 'second', afterTrackId: 'first' })
    const rejected = assert.rejects(pending, { name: 'AbortError' })
    while (!ready) await delay(0)
    await output.command(command); ready(); await rejected
    assert.equal(calls.some(item => item.action === 'prepareNext'), false, command.action)
    assert.equal(releaseCount, 1, 'A cancelled decoded file releases its lease exactly once')
    output.dispose()
  }
})

test('native lease promotion follows audio boundary and repeated-track identity; stale state cannot revive preparation', async () => {
  const releases = []
  const { output, calls, state } = bridgeFixture({ prepare: async source => ({ path: '/isolated/next.wav', release: () => releases.push(source.id) }) })
  output.activeLease = { trackId: 'first', release: () => releases.push('active') }
  await output.command({ action: 'prepareNext', trackId: 'first', afterTrackId: 'first' })
  assert.deepEqual(releases, [])
  assert.equal(calls.filter(item => item.action === 'prepareNext').length, 1)
  await output.command({ action: 'prepareNext', trackId: 'first', afterTrackId: 'first' })
  assert.equal(calls.filter(item => item.action === 'prepareNext').length, 1, 'The same prepared next is idempotent')
  state.boundarySerial = 1; state.nextTrackId = ''
  await output.command({ action: 'cancelNext' })
  assert.deepEqual(releases, ['active'], 'Cancelling after repeat-one promotion retains the now playing lease')
  output.dispose(); assert.deepEqual(releases, ['active', 'first'])

  const fixture = bridgeFixture({ prepare: async () => assert.fail('An obsolete state must not start decoding') })
  const originalSend = fixture.output.send
  let releaseState
  fixture.output.send = command => command.action === 'state' ? new Promise(resolve => { releaseState = () => resolve({ ...fixture.state, playing: true, trackId: 'first' }) }) : originalSend(command)
  const obsolete = fixture.output.command({ action: 'prepareNext', trackId: 'second' })
  const rejected = assert.rejects(obsolete, { name: 'AbortError' })
  await fixture.output.command({ action: 'stop' }); releaseState(); await rejected
  assert.equal(fixture.calls.some(item => item.action === 'prepareNext'), false)
  fixture.output.dispose()
})

test('PCM cache pruning respects current/next leases and releases idempotently', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-gapless-leases-'))
  t.after(() => fs.rm(folder, { recursive: true, force: true }))
  const decoder = new AudioDecoder({ dataDir: folder })
  await fs.mkdir(decoder.cacheDir, { recursive: true })
  const files = ['a', 'b', 'c'].map(letter => path.join(decoder.cacheDir, `${letter.repeat(64)}.wav`))
  // Sparse files exercise real 4 GiB accounting without allocating giant buffers.
  for (const [index, file] of files.entries()) { const handle = await fs.open(file, 'w'); await handle.truncate(1536 * 1024 ** 2); await handle.close(); await fs.utimes(file, new Date(1000 + index * 1000), new Date(1000 + index * 1000)) }
  const release = decoder.retain(files[0]); await decoder.prune(files[2]); await fs.access(files[0])
  release(); release(); assert.equal(decoder.leases.size, 0)
  await decoder.prune(files[2]); await assert.rejects(fs.access(files[0]))
  decoder.dispose()
})

test('real zero-gain device advances across predecoded mixed-rate files without a JS play command', { skip: process.platform !== 'darwin' }, async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-gapless-device-'))
  t.after(() => fs.rm(folder, { recursive: true, force: true }))
  const first = path.join(folder, 'first.wav'), second = path.join(folder, 'second.wav')
  await fs.writeFile(first, floatWav(44100, 1, 0.25)); await fs.writeFile(second, floatWav(48000, 0.75, 0.5))
  const decoder = new AudioDecoder({ dataDir: path.join(folder, 'data') })
  const output = new NativeAudioOutput({ dataDir: path.join(folder, 'data'), decoder, trackFile: id => ({ path: id === 'first' ? first : second, allowedRoot: folder }) })
  t.after(() => { output.dispose(); decoder.dispose() })
  await decoder.prepare({ path: second, allowedRoot: folder })
  const playing = await output.command({ action: 'play', trackId: 'first', transitionMode: 'gapless', volume: 0 })
  const prepared = await output.command({ action: 'prepareNext', trackId: 'second', afterTrackId: 'first' })
  assert.equal(prepared.nextTrackId, 'second'); assert.equal(prepared.volume, 0)
  assert.equal(decoder.leases.size, 2)
  await delay(1150)
  const next = await output.command({ action: 'state' })
  assert.equal(next.trackId, 'second'); assert.equal(next.playing, true); assert.equal(next.boundarySerial, playing.boundarySerial + 1)
  assert.equal(next.endedSerial, playing.endedSerial); assert.ok(next.currentTime > 0 && next.currentTime < 0.6)
  assert.equal(next.volume, 0); assert.equal(decoder.leases.size, 1)
  await delay(850)
  const ended = await output.command({ action: 'state' })
  assert.equal(ended.playing, false); assert.equal(ended.endedSerial, playing.endedSerial + 1)
  await output.command({ action: 'stop' }); assert.equal(decoder.leases.size, 0)
})
