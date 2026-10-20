import test from 'node:test'
import assert from 'node:assert/strict'
import { BrowserGaplessPlayer, pcmWaveFrames, GAPLESS_FILE_BYTES } from '../src/music-browser-gapless.ts'
import { MusicPlayer } from '../src/music-player.ts'

export function wave(frames = 4800, sampleRate = 48000, channels = 2, phase = 0) {
  const data = new ArrayBuffer(44 + frames * channels * 2), view = new DataView(data)
  const text = (at, value) => [...value].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)))
  text(0, 'RIFF'); view.setUint32(4, data.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, frames * channels * 2, true)
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++)
    view.setInt16(44 + (frame * channels + channel) * 2, Math.round(Math.sin((frame + phase) * 137 * Math.PI * 2 / sampleRate + channel * .3) * 20000), true)
  return data
}

const track = id => ({ id, duration: .1, audioUrl: `/raw/${id}` })
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function fixture(t) {
  const original = globalThis.fetch, calls = [], sources = [], events = []
  const contextEvents = new EventTarget()
  let heldDecode
  const context = {
    currentTime: 0, sampleRate: 48000, destination: {}, closed: false, state: 'running',
    addEventListener: (...args) => contextEvents.addEventListener(...args),
    removeEventListener: (...args) => contextEvents.removeEventListener(...args),
    changeState(state) { this.state = state; contextEvents.dispatchEvent(new Event('statechange')) },
    resume: async () => { context.state = 'running' }, close: async () => { context.closed = true },
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createBufferSource: () => {
      const source = { stopped: false, connect() {}, disconnect() {}, stop() { this.stopped = true },
        start(at, offset) { this.at = at; this.offset = offset }, onended: null }
      sources.push(source); return source
    },
    async decodeAudioData(data) {
      const pcm = pcmWaveFrames(data)
      if (heldDecode) await heldDecode
      return { length: pcm.frames, numberOfChannels: pcm.channels, duration: pcm.frames / pcm.sampleRate }
    },
  }
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options })
    if (options.signal?.aborted) throw new DOMException('cancelled', 'AbortError')
    const body = wave()
    return url.includes('/prepare/') ? new Response(JSON.stringify({ bytes: body.byteLength, audioUrl: '/pcm.wav' })) : new Response(body)
  }
  const player = new BrowserGaplessPlayer({ progress: (...args) => events.push(['progress', ...args]), boundary: (...args) => events.push(['boundary', ...args]), ended: () => events.push(['ended']) }, context)
  t.after(() => { player.dispose(); globalThis.fetch = original })
  return { player, context, calls, sources, events, holdDecode(promise) { heldDecode = promise } }
}

test('next source is scheduled on the exact audio boundary before any ended callback', async t => {
  const f = fixture(t)
  await f.player.play(track('a'), 0, new AbortController().signal)
  await f.player.prepareNext(track('b'))
  assert.equal(f.sources.length, 2)
  assert.equal(f.sources[1].at, f.sources[0].at + .1)
  assert.equal(f.events.filter(e => e[0] === 'boundary').length, 0)
  f.context.currentTime = .16
  assert.equal(f.player.trackId, 'b', 'a late main thread only synchronizes metadata')
  assert.equal(f.sources.length, 2, 'synchronization does not start a third source')
  assert.equal(f.events.filter(e => e[0] === 'boundary').length, 1)
  assert.ok(Math.abs(f.player.position - .02) < 1e-9)
})

test('queue replacement cancels only the prepared source and preserves the current timeline', async t => {
  const f = fixture(t)
  await f.player.play(track('a'), 0, new AbortController().signal)
  await f.player.prepareNext(track('b'))
  const first = f.sources[0], discarded = f.sources[1]
  f.context.currentTime = .08
  await f.player.prepareNext(track('c'))
  assert.equal(first.stopped, false)
  assert.equal(discarded.stopped, true)
  assert.equal(f.sources[2].at, .14)
  f.context.currentTime = .15
  assert.equal(f.player.trackId, 'c')
})

test('pause, resume and seek retain exact position while cancelling future starts', async t => {
  const f = fixture(t)
  await f.player.play(track('a'), 0, new AbortController().signal)
  await f.player.prepareNext(track('b'))
  f.context.currentTime = .08
  const position = f.player.pause()
  assert.ok(Math.abs(position - .04) < 1e-9)
  assert.ok(f.sources.every(source => source.stopped))
  const reads = f.calls.length
  await f.player.play(track('a'), position, new AbortController().signal)
  assert.equal(f.calls.length, reads, 'resume retains the decoded current buffer')
  assert.equal(f.sources.at(-1).offset, position)
  f.player.seek(.075)
  await f.player.prepareNext(track('b'))
  assert.ok(Math.abs(f.sources.at(-1).at - (.08 + .04 + .025)) < 1e-9)
  f.player.stop()
  assert.equal(f.player.residentBytes, 0)
  assert.ok(f.sources.every(source => source.stopped))
})

test('superseded decoding remains serialized and cannot revive stopped audio', async t => {
  const f = fixture(t)
  let release
  f.holdDecode(new Promise(resolve => { release = resolve }))
  const abort = new AbortController()
  const pending = f.player.play(track('old'), 0, abort.signal)
  await settle()
  abort.abort(); f.player.stop()
  const latest = f.player.play(track('new'), 0, new AbortController().signal)
  await settle()
  assert.equal(f.calls.length, 2, 'a second file cannot load while cancelled decode still occupies memory')
  release()
  await assert.rejects(pending, { name: 'AbortError' })
  await latest
  assert.equal(f.sources.length, 1)
  assert.equal(f.player.trackId, 'new')
})

test('oversized files and inaccurate PCM dimensions reject before expensive decoding', async t => {
  const f = fixture(t)
  let decodes = 0
  f.context.decodeAudioData = async () => { decodes++; throw new Error('must not decode') }
  globalThis.fetch = async () => new Response(JSON.stringify({ bytes: GAPLESS_FILE_BYTES + 1 }))
  await assert.rejects(f.player.play(track('large'), 0, new AbortController().signal), /内存预算/)
  assert.equal(decodes, 0)
  const truncated = wave().slice(0, 60)
  assert.throws(() => pcmWaveFrames(truncated), /不完整/)
  const malformed = wave(); new DataView(malformed).setUint16(22, 200, true)
  assert.throws(() => pcmWaveFrames(malformed), /格式|采样/)
})

test('an unready next source never starts late under a gapless claim', async t => {
  const f = fixture(t)
  await f.player.play(track('a'), 0, new AbortController().signal)
  f.context.currentTime = .13
  await assert.rejects(f.player.prepareNext(track('b')), /未能及时/)
  assert.equal(f.sources.length, 1)
  f.context.currentTime = .3
  assert.equal(f.player.position, .1)
  assert.equal(f.events.filter(event => event[0] === 'ended').length, 1)
  assert.equal(f.player.position, .1)
  assert.equal(f.events.filter(event => event[0] === 'ended').length, 1)
})

test('disposing during asynchronous work releases sources and rejects late completion', async t => {
  const f = fixture(t)
  let release
  f.holdDecode(new Promise(resolve => { release = resolve }))
  const pending = f.player.play(track('a'), 0, new AbortController().signal)
  await settle()
  f.player.dispose(); release()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(f.sources.length, 0)
  assert.equal(f.context.closed, true)
})

test('removing the successor during decode cancels its still-unassigned slot', async t => {
  const f = fixture(t)
  await f.player.play(track('a'), 0, new AbortController().signal)
  let release
  f.holdDecode(new Promise(resolve => { release = resolve }))
  const preparing = f.player.prepareNext(track('deleted'))
  await settle()
  await f.player.prepareNext(undefined)
  release()
  await assert.rejects(preparing, { name: 'AbortError' })
  assert.equal(f.sources.length, 1)
})

function transportFixture(t) {
  const f = fixture(t)
  const previous = new Map(['AudioContext', 'Audio', 'document'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  class SilentAudio extends EventTarget {
    paused = true; ended = false; currentTime = 0; duration = 10; volume = 0; readyState = 1
    play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve() }
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
    load() {} removeAttribute() {}
  }
  globalThis.AudioContext = class { constructor() { return f.context } }
  globalThis.Audio = SilentAudio
  globalThis.document = new EventTarget()
  const transport = new MusicPlayer({ songTransitionMode: 'gapless', bgmEnabled: false, volume: 0 })
  t.after(() => {
    transport.dispose()
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  })
  const tracks = ['a', 'b', 'c'].map(id => ({ ...track(id), title: id, browserPlayable: true, relativePath: `${id}.wav`, format: 'WAV' }))
  return { ...f, transport, tracks }
}

test('production transport follows the audio boundary without issuing another play request', async t => {
  const f = transportFixture(t)
  await f.transport.play('a', f.tracks); await settle()
  assert.equal(f.sources.length, 2)
  f.context.currentTime = .16
  f.sources[0].onended()
  assert.equal(f.transport.state.currentTrack.id, 'b')
  assert.equal(f.transport.state.transport, 'playing')
  await settle()
  assert.equal(f.sources.length, 3, 'only the successor c is newly prepared')
  assert.equal(f.sources[1].at, .14)
  assert.ok(Math.abs(f.sources[2].at - .24) < 1e-12)
  assert.equal(f.transport.state.transitionWarning, null)
})

test('manual next at an unobserved audio boundary selects c once, rather than replaying b', async t => {
  const f = transportFixture(t)
  await f.transport.play('a', f.tracks); await settle()
  f.context.currentTime = .16
  await f.transport.next(); await settle()
  assert.equal(f.transport.state.currentTrack.id, 'c')
  assert.equal(f.transport.state.currentTime, 0)
  assert.equal(f.sources.filter(source => !source.stopped).length, 1)
})

test('production queue deletion while next decoding is held cannot play the deleted song', async t => {
  const f = transportFixture(t)
  let release
  await f.transport.play('a', [f.tracks[0]])
  f.holdDecode(new Promise(resolve => { release = resolve }))
  f.transport.setQueue(f.tracks)
  await settle()
  f.transport.setQueue([f.tracks[0]])
  release(); await settle()
  assert.equal(f.sources.length, 1)
  f.context.currentTime = .16; f.sources[0].onended()
  assert.equal(f.transport.state.transport, 'idle')
  assert.equal(f.transport.state.currentTrack.id, 'a')
})

test('production mode changes preserve a paused position and cannot autoplay', async t => {
  const f = transportFixture(t)
  await f.transport.play('a', f.tracks); await settle()
  f.context.currentTime = .08
  await f.transport.toggle()
  const position = f.transport.state.currentTime
  assert.ok(Math.abs(position - .04) < 1e-9)
  f.transport.setSongTransitionMode('fade-out')
  assert.equal(f.transport.state.transport, 'paused')
  assert.equal(f.transport.state.currentTime, position)
  f.transport.setSongTransitionMode('gapless')
  assert.equal(f.transport.state.transport, 'paused')
  await f.transport.toggle(); await settle()
  assert.equal(f.sources.at(-2).offset, position)
  assert.equal(f.transport.state.transport, 'playing')
})

test('production backend handoff samples the actual playing track before capturing its position', async t => {
  const f = transportFixture(t)
  await f.transport.play('a', f.tracks); await settle()
  const audioFetch = globalThis.fetch, native = []
  globalThis.fetch = async (url, options) => {
    if (url === '/api/audio/capabilities') return new Response(JSON.stringify({ nativeAvailable: true, decoderAvailable: true, devices: [] }))
    if (url === '/api/output/command') {
      const command = JSON.parse(options.body); native.push(command)
      return new Response(JSON.stringify({ trackId: command.trackId ?? 'b', currentTime: 0, duration: .1, playing: command.action === 'play', deviceId: 'default', endedSerial: 0 }))
    }
    return audioFetch(url, options)
  }
  f.context.currentTime = .16
  await f.transport.setBackend('coreaudio'); await settle()
  assert.equal(native.find(command => command.action === 'play').trackId, 'b')
  assert.ok(Math.abs(native.find(command => command.action === 'seek').position - .02) < 1e-9)
  assert.ok(f.sources.every(source => source.stopped))
})

test('production late preparation reports an explicit queue-wide fallback', async t => {
  const f = transportFixture(t)
  await f.transport.play('a', [f.tracks[0]])
  f.context.currentTime = .13
  f.transport.setQueue(f.tracks); await settle()
  assert.match(f.transport.state.transitionWarning, /未能及时.*普通播放/)
  f.context.currentTime = .16; f.sources[0].onended(); await settle()
  assert.equal(f.transport.state.currentTrack.id, 'b')
  assert.equal(f.transport.state.transport, 'playing')
  assert.match(f.transport.state.transitionWarning, /普通播放/)
  f.transport.stop()
  assert.equal(f.transport.state.transitionWarning, null)
})

test('a new explicit queue retries gapless after the old queue needed ordinary playback', async t => {
  const f = transportFixture(t)
  await f.transport.play('a', [f.tracks[0]])
  f.context.currentTime = .13
  f.transport.setQueue(f.tracks); await settle()
  assert.match(f.transport.state.transitionWarning, /普通播放/)
  await f.transport.play('c', [f.tracks[2]]); await settle()
  assert.equal(f.transport.state.transitionWarning, null)
  assert.equal(f.transport.state.currentTrack.id, 'c')
  assert.equal(f.sources.at(-1).stopped, false)
})

test('a suspended audio clock pauses the transport without letting the future source escape', async t => {
  const f = transportFixture(t)
  await f.transport.play('a', f.tracks); await settle()
  f.context.currentTime = .08
  f.context.changeState('suspended')
  assert.equal(f.transport.state.transport, 'paused')
  assert.equal(f.transport.state.playing, false)
  assert.ok(Math.abs(f.transport.state.currentTime - .04) < 1e-9)
  assert.ok(f.sources.every(source => source.stopped))
})

test('clock suspension during decoding stays paused until an explicit resume', async t => {
  const f = transportFixture(t)
  let release
  f.holdDecode(new Promise(resolve => { release = resolve }))
  const pending = f.transport.play('a', [f.tracks[0]])
  await settle()
  f.context.changeState('suspended')
  release(); await pending
  assert.equal(f.transport.state.transport, 'paused')
  assert.equal(f.sources.length, 0)
  await f.transport.toggle()
  assert.equal(f.transport.state.transport, 'playing')
  assert.equal(f.sources.length, 1)
})
