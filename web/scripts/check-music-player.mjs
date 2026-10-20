import test from 'node:test'
import assert from 'node:assert/strict'
import { MusicPlayer } from '../src/music-player.ts'

const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }

/** No browser, network, real timers, or actual sound is used by these tests. */
function environment(t) {
  let now = 0
  let nextTimer = 1
  const timers = new Map()
  const instances = []
  const document = new EventTarget()
  const previousAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousTimeout = globalThis.setTimeout
  const previousClear = globalThis.clearTimeout
  const previousNow = Object.getOwnPropertyDescriptor(performance, 'now')

  class ControlledAudio extends EventTarget {
    constructor(src = '') {
      super()
      this.src = src
      this.volume = 1
      this.paused = true
      this.ended = false
      this.duration = 120
      this.currentTime = 0
      this.readyState = 1
      this.playCalls = 0
      this.deferred = []
      this.holdPlay = false
      instances.push(this)
    }

    play() {
      this.playCalls += 1
      if (this.holdPlay) {
        this.holdPlay = false
        return new Promise((resolve) => this.deferred.push(() => { this.begin(); resolve() }))
      }
      this.begin()
      return Promise.resolve()
    }

    begin() {
      this.paused = false
      this.dispatchEvent(new Event('playing'))
    }

    resolvePlay() {
      assert.ok(this.deferred.length, 'there must be a held audio play request')
      this.deferred.shift()()
    }

    pause() {
      if (this.paused) return
      this.paused = true
      this.dispatchEvent(new Event('pause'))
    }

    removeAttribute(name) { if (name === 'src') this.src = '' }
    load() {}
  }

  Object.defineProperty(globalThis, 'Audio', { configurable: true, writable: true, value: ControlledAudio })
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document })
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now })
  globalThis.setTimeout = (callback, delay = 0) => {
    const id = nextTimer++
    timers.set(id, { callback, at: now + Number(delay) })
    return id
  }
  globalThis.clearTimeout = (id) => timers.delete(id)
  t.after(() => {
    if (previousAudio) Object.defineProperty(globalThis, 'Audio', previousAudio)
    else delete globalThis.Audio
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else delete globalThis.document
    if (previousNow) Object.defineProperty(performance, 'now', previousNow)
    else delete performance.now
    globalThis.setTimeout = previousTimeout
    globalThis.clearTimeout = previousClear
  })

  return {
    instances,
    gesture: () => document.dispatchEvent(new Event('pointerdown')),
    pendingTimers: () => timers.size,
    async advance(milliseconds) {
      await settle()
      const end = now + milliseconds
      let next
      while ((next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0])) {
        now = next[1].at
        timers.delete(next[0])
        next[1].callback()
        await settle()
      }
      now = end
      await settle()
    },
  }
}

const track = (id) => ({ id, albumId: 'album-test', title: id, artist: 'Test artist', duration: 120, format: 'WAV', browserPlayable: true, relativePath: `${id}.wav`, audioUrl: `/api/audio/${id}` })
const dsdTrack = (format, legacy = false) => {
  const id = format.toLowerCase()
  return { ...track(id), format, relativePath: `source.${id}`, browserPlayable: false, localDecodable: !legacy, ...(legacy ? {} : { decodedAudioUrl: `/api/decoded-audio/${id}` }) }
}
const near = (actual, expected, message = `expected ${actual} ≈ ${expected}`) => assert.ok(Math.abs(actual - expected) < 0.0001, message)

const transitionModes = ['fade-out', 'fade-in-out', 'gapless']
async function playSettled(env, player, id, tracks) {
  const pending = player.play(id, tracks)
  await env.advance(1000)
  await pending
}

function finishSong(audio) {
  // Match HTMLMediaElement's natural end ordering: ended is already true when
  // pause fires, then the ended event asks the player to advance the queue.
  audio.currentTime = audio.duration
  audio.ended = true
  audio.paused = true
  audio.dispatchEvent(new Event('pause'))
  audio.dispatchEvent(new Event('ended'))
}

test('BGM has an independent default, live volume, zero-volume gate, and clamped settings', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ volume: 0 })
  const bgm = env.instances[0]
  assert.equal(player.state.songFadeEnabled, true)
  assert.equal(player.state.bgmVolume, 0.18)
  assert.equal(bgm.playCalls, 0, 'no autoplay before a gesture')
  env.gesture()
  await env.advance(700)
  near(bgm.volume, 0.18)
  assert.equal(player.state.bgmPlaying, true, 'muted songs do not mute the BGM')
  player.setVolume(1)
  await env.advance(700)
  near(bgm.volume, 0.18)
  player.setBgmVolume(0.42)
  await env.advance(700)
  near(bgm.volume, 0.42)
  assert.equal(player.state.volume, 1)
  player.setBgmVolume(NaN)
  assert.equal(player.state.bgmVolume, 0.42)
  player.setBgmVolume(-1)
  await env.advance(250)
  assert.equal(player.state.bgmVolume, 0)
  assert.equal(bgm.paused, true)
  assert.equal(player.state.bgmEnabled, true, 'zero volume preserves the independent enabled preference')
  player.setBgmVolume(9)
  await env.advance(700)
  assert.equal(player.state.bgmVolume, 1)
  near(bgm.volume, 1)
  player.dispose()
  assert.equal(env.pendingTimers(), 0)
})

test('song playback waits for BGM silence despite rapid BGM volume and toggle changes', async (t) => {
  const env = environment(t)
  // Isolate BGM timing from the optional song envelope in this transport check.
  const player = new MusicPlayer({ volume: 0.65, bgmVolume: 0.3, songFadeEnabled: false })
  player.setQueue([track('first')])
  env.gesture()
  await env.advance(700)
  const bgm = env.instances[0]
  const playing = player.play('first')
  const song = env.instances[1]
  await env.advance(96)
  assert.equal(song.playCalls, 0)
  assert.ok(bgm.volume > 0 && bgm.volume < 0.3)
  player.setBgmVolume(0.8)
  player.setBgmEnabled(false)
  player.setBgmEnabled(true)
  player.setVolume(0.25)
  await env.advance(100)
  assert.equal(song.playCalls, 0, 'controls must not bypass the shared fade-out promise')
  await env.advance(60)
  await playing
  assert.equal(song.playCalls, 1)
  assert.equal(song.volume, 0.25)
  assert.equal(bgm.volume, 0)
  assert.equal(bgm.paused, true)
  assert.equal(player.state.playing, true)
  assert.equal(player.state.bgmVolume, 0.8)
  player.setBgmVolume(0.4)
  await env.advance(700)
  assert.equal(song.volume, 0.25, 'BGM volume cannot alter song output')
  assert.equal(bgm.paused, true, 'BGM stays silent while a song plays')
  player.stop()
  await env.advance(700)
  near(bgm.volume, 0.4)
  assert.equal(player.state.bgmPlaying, true)
  player.dispose()
})

test('rapidly cancelling a pending song restores only the latest BGM volume', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ bgmVolume: 0.5 })
  player.setQueue([track('first')])
  env.gesture()
  await env.advance(700)
  const bgm = env.instances[0]
  const pending = player.play('first')
  const song = env.instances[1]
  await env.advance(72)
  player.stop()
  player.setBgmVolume(0.2)
  player.setBgmEnabled(false)
  await env.advance(24)
  player.setBgmEnabled(true)
  player.setBgmVolume(0.33)
  await env.advance(700)
  await pending
  assert.equal(song.playCalls, 0, 'cancelled song never starts after the old fade finishes')
  assert.equal(song.paused, true)
  near(bgm.volume, 0.33)
  assert.equal(player.state.bgmPlaying, true)
  assert.equal(player.state.playing, false)
  player.dispose()
  await env.advance(1000)
  assert.equal(bgm.paused, true)
  assert.equal(env.pendingTimers(), 0)
})

test('a late BGM play resolution stays silent when a song has taken over', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ bgmVolume: 0.4, songFadeEnabled: false })
  const bgm = env.instances[0]
  bgm.holdPlay = true
  player.setQueue([track('first')])
  env.gesture()
  await settle()
  assert.equal(bgm.playCalls, 1)
  const playing = player.play('first')
  await env.advance(250)
  await playing
  const song = env.instances[1]
  assert.equal(song.paused, false)
  bgm.resolvePlay()
  await settle()
  assert.equal(bgm.paused, true)
  assert.equal(bgm.volume, 0)
  assert.equal(player.state.bgmPlaying, false)
  assert.equal(player.state.playing, true)
  player.dispose()
})

function nativeFetch(t) {
  const original = globalThis.fetch
  const calls = []
  const requests = []
  const state = { trackId: '', playing: false, currentTime: 0, duration: 120, deviceId: 'default', endedSerial: 0, nextTrackId: '', boundarySerial: 0 }
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    if (url === '/api/audio/capabilities') return { ok: true, json: async () => ({ decoderAvailable: true, nativeAvailable: true, devices: [{ id: 'default', name: 'Default' }, { id: '42', name: 'Test DAC' }] }) }
    if (url === '/api/output/command') {
      const command = JSON.parse(options.body); calls.push(command)
      if (command.action === 'device') state.deviceId = command.deviceId
      if (command.action === 'play') { if (state.trackId !== command.trackId) state.currentTime = 0; state.trackId = command.trackId; state.playing = true }
      if (command.action === 'pause') state.playing = false
      if (command.action === 'stop') { state.playing = false; state.trackId = ''; state.currentTime = 0 }
      if (command.action === 'seek') state.currentTime = command.position
      if (command.action === 'prepareNext') state.nextTrackId = command.trackId
      if (command.action === 'cancelNext') state.nextTrackId = ''
    }
    return { ok: true, json: async () => ({ ...state }) }
  }
  t.after(() => { globalThis.fetch = original })
  return { state, calls, requests }
}

test('transition modes preserve legacy choices and expose an unambiguous current mode', (t) => {
  environment(t)
  for (const [options, expected] of [
    [{}, 'fade-in-out'],
    [{ songFadeEnabled: false }, 'gapless'],
    [{ songFadeEnabled: true }, 'fade-in-out'],
    [{ songFadeEnabled: false, songTransitionMode: 'fade-out' }, 'fade-out'],
    [{ songTransitionMode: 'unknown', songFadeEnabled: false }, 'gapless'],
  ]) {
    const player = new MusicPlayer(options)
    assert.equal(player.state.songTransitionMode, expected)
    assert.equal(player.state.songFadeEnabled, expected !== 'gapless')
    player.setSongFadeEnabled(false)
    assert.equal(player.state.songTransitionMode, 'gapless')
    player.setSongFadeEnabled(true)
    assert.equal(player.state.songTransitionMode, 'fade-in-out')
    player.setSongTransitionMode('fade-out')
    assert.equal(player.state.songFadeEnabled, true)
    player.dispose()
  }
})

for (const mode of transitionModes) {
  test(`${mode}: incoming and outgoing envelopes use the selected mode and current volume`, async (t) => {
    const env = environment(t)
    const player = new MusicPlayer({ songTransitionMode: mode, volume: 0.6, bgmEnabled: false })
    const initial = player.play('first', [track('first'), track('second')])
    await settle()
    const first = env.instances[1]
    assert.equal(first.playCalls, 1)
    near(first.volume, mode === 'fade-in-out' ? 0 : 0.6)
    await env.advance(224)
    near(first.volume, mode === 'fade-in-out' ? 0.6 * 224 / 450 : 0.6)
    await env.advance(240)
    await initial
    near(first.volume, 0.6)

    const switching = player.play('second')
    await settle()
    if (mode !== 'gapless') {
      assert.equal(first.paused, false)
      near(first.volume, 0.6)
      assert.equal(env.instances.length, 2, 'next song cannot start before the outgoing fade finishes')
      await env.advance(224)
      near(first.volume, 0.6 * (1 - 224 / 450))
      player.setVolume(0.8)
      near(first.volume, 0.8 * (1 - 224 / 450), 'volume changes retain the current fade gain')
      await env.advance(240)
    }
    const second = env.instances[2]
    assert.ok(second)
    assert.equal(first.paused, true)
    assert.equal(first.src, '', 'release the outgoing resource')
    assert.equal(second.playCalls, 1)
    const volume = mode === 'gapless' ? 0.6 : 0.8
    near(second.volume, mode === 'fade-in-out' ? 0 : volume)
    await env.advance(224)
    near(second.volume, mode === 'fade-in-out' ? volume * 224 / 450 : volume)
    await env.advance(240)
    await switching
    near(second.volume, volume)
    assert.equal(player.state.currentTrack.id, 'second')
    assert.equal(player.state.transport, 'playing')
    player.dispose()
    assert.equal(env.pendingTimers(), 0)
  })

  test(`${mode}: rapid replacement cannot start an obsolete destination`, async (t) => {
    const env = environment(t)
    const player = new MusicPlayer({ songTransitionMode: mode, bgmEnabled: false })
    await playSettled(env, player, 'first', [track('first'), track('second'), track('third')])
    const first = env.instances[1]
    const obsolete = player.play('second')
    if (mode !== 'gapless') await env.advance(112)
    const latest = player.play('third')
    await env.advance(1000)
    await Promise.all([obsolete, latest])
    assert.equal(player.state.currentTrack.id, 'third')
    assert.equal(player.state.transport, 'playing')
    assert.equal(first.paused, true)
    const audible = env.instances.slice(1).filter((audio) => !audio.paused)
    assert.equal(audible.length, 1)
    assert.equal(audible[0].src, '/api/audio/third')
    assert.equal(audible[0].playCalls, 1)
    assert.equal(env.instances.slice(2, -1).reduce((total, audio) => total + audio.playCalls, 0), 0)
    player.dispose()
    assert.equal(env.pendingTimers(), 0)
  })

  for (const interrupt of ['pause', 'stop']) {
    test(`${mode}: ${interrupt} invalidates an in-flight switch and its delayed continuation`, async (t) => {
      const env = environment(t)
      const player = new MusicPlayer({ songTransitionMode: mode, bgmEnabled: false })
      await playSettled(env, player, 'first', [track('first'), track('second')])
      const switching = player.play('second')
      if (mode !== 'gapless') await env.advance(112)
      if (interrupt === 'pause') await player.toggle()
      else player.stop()
      await env.advance(1200)
      await switching
      assert.equal(player.state.transport, interrupt === 'pause' ? 'paused' : 'idle')
      assert.equal(player.state.playing, false)
      assert.equal(player.state.loading, false)
      assert.ok(env.instances.every((audio) => audio.paused))
      assert.equal(env.instances.slice(2).reduce((total, audio) => total + audio.playCalls, 0), 0)
      player.dispose()
      assert.equal(env.pendingTimers(), 0)
    })
  }

  for (const interrupt of ['pause', 'stop', 'replacement']) {
    test(`${mode}: a late song play promise cannot undo ${interrupt}`, async (t) => {
      const env = environment(t)
      const player = new MusicPlayer({ songTransitionMode: mode, bgmEnabled: false })
      const pending = player.play('first', [track('first'), track('second')])
      const late = env.instances[1]
      late.holdPlay = true
      await settle()
      assert.equal(late.playCalls, 1)
      assert.equal(late.deferred.length, 1)
      if (interrupt === 'pause') await player.toggle()
      else if (interrupt === 'stop') player.stop()
      else await playSettled(env, player, 'second')
      late.resolvePlay()
      await pending
      await env.advance(1000)
      assert.equal(late.paused, true, 'a stale play resolution is made silent again')
      assert.equal(player.state.transport, interrupt === 'replacement' ? 'playing' : interrupt === 'pause' ? 'paused' : 'idle')
      assert.equal(player.state.currentTrack.id, interrupt === 'replacement' ? 'second' : 'first')
      assert.equal(env.instances.filter((audio) => !audio.paused).length, interrupt === 'replacement' ? 1 : 0)
      player.dispose()
      assert.equal(env.pendingTimers(), 0)
    })
  }

  test(`${mode}: natural queue advance stays silent between songs and ends at the queue boundary`, async (t) => {
    const env = environment(t)
    const player = new MusicPlayer({ songTransitionMode: mode, volume: 0.6, bgmVolume: 0.3 })
    env.gesture()
    await env.advance(700)
    const bgm = env.instances[0]
    await playSettled(env, player, 'first', [track('first'), track('second')])
    const bgmStarts = bgm.playCalls
    const states = []
    const unsubscribe = player.subscribe((state) => states.push(state.transport))
    finishSong(env.instances[1])
    await settle()
    const second = env.instances[2]
    assert.equal(second.playCalls, 1)
    near(second.volume, mode === 'fade-in-out' ? 0 : 0.6)
    assert.equal(player.state.currentTrack.id, 'second')
    await env.advance(500)
    assert.equal(bgm.playCalls, bgmStarts, 'natural advance cannot insert a BGM play request')
    assert.equal(bgm.paused, true)
    near(bgm.volume, 0)
    assert.ok(!states.includes('idle'), 'queue handoff has no idle intermediate state')
    finishSong(second)
    await env.advance(700)
    assert.equal(player.state.transport, 'idle')
    assert.equal(player.state.currentTrack.id, 'second')
    assert.equal(env.instances.length, 3, 'the last track does not wrap or create another song')
    assert.equal(bgm.playCalls, bgmStarts + 1)
    near(bgm.volume, 0.3)
    finishSong(second)
    await env.advance(500)
    assert.equal(env.instances.length, 3, 'duplicate ended cannot restart the queue')
    unsubscribe()
    player.dispose()
    assert.equal(env.pendingTimers(), 0)
  })
}

for (const mode of ['fade-out']) {
  test(`changing an incoming fade to ${mode} restores full volume without replay`, async (t) => {
    const env = environment(t)
    const player = new MusicPlayer({ songTransitionMode: 'fade-in-out', volume: 0.65, bgmEnabled: false })
    const pending = player.play('first', [track('first')])
    await env.advance(160)
    const audio = env.instances[1]
    near(audio.volume, 0.65 * 160 / 450)
    player.setSongTransitionMode(mode)
    near(audio.volume, 0.65)
    await pending
    player.setSongTransitionMode('fade-in-out')
    await env.advance(700)
    near(audio.volume, 0.65)
    assert.equal(audio.playCalls, 1)
    assert.equal(env.instances.length, 2)
    assert.equal(player.state.transport, 'playing')
    player.dispose()
    assert.equal(env.pendingTimers(), 0)
  })
}

test('changing an outgoing fade to direct playback finishes the current switch once', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ songTransitionMode: 'fade-out', volume: 0.65, bgmEnabled: false })
  await playSettled(env, player, 'first', [track('first'), track('second')])
  const first = env.instances[1]
  const switching = player.play('second')
  await env.advance(160)
  const outgoingVolume = first.volume
  player.setSongTransitionMode('gapless')
  near(first.volume, outgoingVolume, 'an outgoing source must not jump back to full volume')
  await switching
  const second = env.instances[2]
  assert.equal(first.paused, true)
  near(second.volume, 0.65)
  player.setSongTransitionMode('fade-out')
  await env.advance(700)
  assert.equal(second.playCalls, 1)
  assert.equal(env.instances.length, 4, 'leaving the gapless engine retains the track through a new standard source')
  assert.equal(second.paused, true)
  assert.equal(env.instances[3].playCalls, 1)
  assert.equal(player.state.currentTrack.id, 'second')
  player.dispose()
  assert.equal(env.pendingTimers(), 0)
})

test('changing fade-out-only to dual fading preserves the in-flight outgoing envelope', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ songTransitionMode: 'fade-out', volume: 0.6, bgmEnabled: false })
  await playSettled(env, player, 'first', [track('first'), track('second')])
  const switching = player.play('second')
  await env.advance(224)
  player.setSongTransitionMode('fade-in-out')
  assert.equal(env.instances.length, 2)
  near(env.instances[1].volume, 0.6 * (1 - 224 / 450))
  await env.advance(240)
  const second = env.instances[2]
  near(second.volume, 0)
  await env.advance(224)
  near(second.volume, 0.6 * 224 / 450)
  await env.advance(240)
  await switching
  near(second.volume, 0.6)
  assert.equal(second.playCalls, 1)
  player.dispose()
  assert.equal(env.pendingTimers(), 0)
})

test('CoreAudio receives all three transition modes and updates live without restarting playback', async (t) => {
  const env = environment(t)
  const native = nativeFetch(t)
  const player = new MusicPlayer({ songTransitionMode: 'fade-out', bgmEnabled: false })
  await player.setBackend('coreaudio')
  for (const mode of transitionModes) {
    player.setSongTransitionMode(mode)
    await settle()
    assert.deepEqual(native.calls.findLast(command => command.action === 'transition'), { action: 'transition', transitionMode: mode })
    await player.play(mode, transitionModes.map(track))
    const command = native.calls.findLast(command => command.action === 'play')
    assert.equal(command.action, 'play')
    assert.equal(command.transitionMode, mode)
    assert.equal(Object.hasOwn(command, 'fadeEnabled'), false, 'new requests must not collapse three choices to a boolean')
  }
  const plays = native.calls.filter((command) => command.action === 'play').length
  player.setSongTransitionMode('fade-out')
  await settle()
  assert.equal(native.calls.filter((command) => command.action === 'play').length, plays)
  assert.equal(player.state.transport, 'playing')
  player.dispose()
  await settle()
  assert.equal(env.pendingTimers(), 0)
})

for (const action of ['pause', 'seek', 'mode', 'queue', 'next', 'backend']) {
  test(`native gapless ${action} synchronizes a physical handoff before the next UI poll`, async t => {
    const env = environment(t), native = nativeFetch(t)
    const player = new MusicPlayer({ songTransitionMode: 'gapless', bgmEnabled: false })
    await player.setBackend('coreaudio')
    await player.play('a', ['a', 'b', 'c'].map(track)); await settle()
    assert.equal(native.state.nextTrackId, 'b')
    Object.assign(native.state, { trackId: 'b', nextTrackId: '', currentTime: .02, boundarySerial: 1 })
    if (action === 'pause') {
      await player.toggle()
      assert.equal(player.state.currentTrack.id, 'b')
      assert.equal(player.state.currentTime, .02)
      await player.toggle()
      assert.equal(native.calls.findLast(command => command.action === 'play').trackId, 'b')
    } else if (action === 'seek') {
      player.seek(17); await settle()
      assert.equal(player.state.currentTrack.id, 'b')
      assert.equal(player.state.currentTime, 17)
    } else if (action === 'mode') {
      player.setSongTransitionMode('fade-out'); await settle()
      assert.equal(player.state.currentTrack.id, 'b')
      assert.equal(player.state.currentTime, .02)
      assert.equal(native.calls.filter(command => command.action === 'play').length, 1)
    } else if (action === 'queue') {
      player.setQueue(['b', 'c'].map(track)); await settle()
      assert.equal(player.state.currentTrack.id, 'b')
      assert.equal(player.state.currentIndex, 0)
      assert.equal(native.state.nextTrackId, 'c')
    } else if (action === 'next') {
      await player.next(); await settle()
      assert.equal(player.state.currentTrack.id, 'c')
      assert.equal(native.calls.findLast(command => command.action === 'play').trackId, 'c')
    } else {
      await player.setBackend('browser'); await settle()
      assert.equal(player.state.currentTrack.id, 'b')
      env.instances.at(-1).dispatchEvent(new Event('loadedmetadata'))
      assert.equal(player.state.currentTime, .02)
    }
    player.dispose(); await settle(); assert.equal(env.pendingTimers(), 0)
  })
}

for (const short of [false, true]) {
  test(`native gapless polling ${short ? 'reports a missed short-track preparation and falls back once' : 'only adopts the already-playing source'}`, async t => {
    const env = environment(t), native = nativeFetch(t)
    const player = new MusicPlayer({ songTransitionMode: 'gapless', bgmEnabled: false })
    await player.setBackend('coreaudio')
    await player.play('a', ['a', 'b', 'c'].map(track)); await settle()
    Object.assign(native.state, { trackId: 'b', nextTrackId: '', currentTime: short ? .05 : .02, duration: short ? .05 : 120,
      boundarySerial: 1, playing: !short, endedSerial: short ? 1 : 0 })
    await env.advance(250)
    assert.equal(player.state.currentTrack.id, short ? 'c' : 'b')
    assert.equal(player.state.transport, 'playing')
    assert.equal(native.calls.filter(command => command.action === 'play').length, short ? 2 : 1)
    if (short) assert.match(player.state.transitionWarning, /普通播放/)
    else assert.equal(player.state.transitionWarning, null)
    player.dispose(); await settle(); assert.equal(env.pendingTimers(), 0)
  })
}

test('a late native pause response cannot overwrite a replacement track position', async t => {
  const env = environment(t), native = nativeFetch(t)
  const player = new MusicPlayer({ songTransitionMode: 'gapless', bgmEnabled: false })
  await player.setBackend('coreaudio')
  await player.play('a', ['a', 'b'].map(track)); await settle()
  const request = globalThis.fetch
  let release
  globalThis.fetch = async (url, options) => {
    const response = await request(url, options)
    if (url === '/api/output/command' && JSON.parse(options.body).action === 'pause') {
      const result = await response.json()
      return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ ...result, currentTime: 99 }) }) })
    }
    return response
  }
  const paused = player.toggle(); await settle()
  await player.play('b'); native.state.currentTime = 7
  release(); await paused
  assert.equal(player.state.currentTrack.id, 'b')
  assert.equal(player.state.transport, 'playing')
  assert.notEqual(player.state.currentTime, 99)
  player.dispose(); await settle(); assert.equal(env.pendingTimers(), 0)
})

test('CoreAudio transport retains paused position when switching backend, and auto-advances without BGM', async (t) => {
  const env = environment(t)
  const native = nativeFetch(t)
  const player = new MusicPlayer({ songFadeEnabled: false, bgmEnabled: false })
  player.setQueue([track('first'), track('second')])
  await player.play('first')
  player.seek(37)
  await player.toggle()
  assert.equal(player.state.transport, 'paused')
  await player.setBackend('coreaudio', '42')
  assert.equal(player.state.currentTime, 37)
  assert.equal(player.state.transport, 'paused')
  await player.toggle()
  await settle()
  assert.equal(native.state.currentTime, 37, 'paused backend switch must retain the next resume position')
  assert.equal(player.state.backend, 'coreaudio')
  assert.equal(player.state.outputDeviceId, '42')
  native.state.endedSerial = 1; native.state.playing = false; native.state.currentTime = 120
  await env.advance(250)
  assert.equal(player.state.currentTrack.id, 'second')
  assert.equal(player.state.playing, true)
  assert.equal(env.instances[0].paused, true)
  player.seek(22); await settle(); await player.toggle()
  await player.setBackend('browser')
  await player.toggle()
  const browserSong = env.instances.at(-1)
  browserSong.dispatchEvent(new Event('loadedmetadata'))
  assert.equal(browserSong.currentTime, 22, 'CoreAudio to browser paused resume retains position')
  player.dispose(); await settle(); assert.equal(env.pendingTimers(), 0)
})

test('local decode preparation cancellation never starts a late browser source', async (t) => {
  const env = environment(t)
  const original = globalThis.fetch
  let release
  globalThis.fetch = () => new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({ audioUrl: '/api/decoded-audio/ape', duration: 120 }) }) })
  t.after(() => { globalThis.fetch = original })
  const player = new MusicPlayer({ songFadeEnabled: false, bgmEnabled: false })
  const ape = { ...track('ape'), format: 'APE', relativePath: 'source.ape', browserPlayable: false, localDecodable: true, decodedAudioUrl: '/api/decoded-audio/ape' }
  const playing = player.play('ape', [ape])
  await settle(); assert.equal(player.state.loading, true)
  player.stop(); release(); await playing
  assert.equal(player.state.transport, 'idle')
  assert.equal(env.instances.length, 1, 'cancelled decode never creates or starts a song')
  player.dispose()
})


test('browser APE playback prepares PCM without probing or starting native capabilities', async (t) => {
  const env = environment(t)
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    assert.equal(url, '/api/audio/prepare/ape', 'browser decoding does not require native discovery')
    return { ok: true, json: async () => ({ audioUrl: '/api/decoded-audio/ape', duration: 120 }) }
  }
  t.after(() => { globalThis.fetch = original })
  const player = new MusicPlayer({ songFadeEnabled: false, bgmEnabled: false })
  const ape = { ...track('ape'), format: 'APE', relativePath: 'source.ape', browserPlayable: false, localDecodable: true, decodedAudioUrl: '/api/decoded-audio/ape' }
  assert.equal(player.state.decoderAvailable, false, 'capabilities have not been probed')
  await player.play('ape', [ape])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(env.instances.at(-1).src, '/api/decoded-audio/ape')
  assert.equal(player.state.playing, true)
  player.dispose()
  assert.equal(calls.length, 1, 'disposing a browser-only player does not start CoreAudio')
})

test('native playback survives visibility changes, but dispose sends one unload-safe stop', async (t) => {
  const env = environment(t)
  const native = nativeFetch(t)
  const player = new MusicPlayer({ songFadeEnabled: false, bgmEnabled: false })
  await player.setBackend('coreaudio')
  await player.play('first', [track('first')])
  const stopsBefore = native.calls.filter((call) => call.action === 'stop').length
  document.dispatchEvent(new Event('visibilitychange'))
  await settle()
  assert.equal(player.state.playing, true, 'hidden pages retain music playback')
  assert.equal(native.calls.filter((call) => call.action === 'stop').length, stopsBefore)
  player.dispose()
  player.dispose()
  await settle()
  const stops = native.requests.filter(({ url, options }) => url === '/api/output/command' && JSON.parse(options.body).action === 'stop')
  assert.equal(stops.length, stopsBefore + 1, 'dispose is idempotent')
  assert.equal(stops.at(-1).options.keepalive, true, 'pagehide stop can finish after the document unloads')
  assert.equal(stops.at(-1).options.headers['Content-Type'], 'application/json', 'preserve the service JSON/Origin protections')
  assert.equal(native.state.playing, false)
  assert.equal(env.pendingTimers(), 0)
})

for (const format of ['DSF', 'DFF']) {
  for (const legacy of [false, true]) {
    test(`browser ${format} ${legacy ? 'legacy index' : 'current index'} plays prepared PCM and resumes without decoding again`, async (t) => {
      const env = environment(t)
      const original = globalThis.fetch
      const source = dsdTrack(format, legacy)
      const calls = []
      globalThis.fetch = async (url, options) => {
        calls.push({ url, options })
        assert.equal(url, `/api/audio/prepare/${source.id}`, 'DSD uses local preparation without native device discovery')
        return { ok: true, json: async () => ({ audioUrl: `/api/decoded-audio/${source.id}`, duration: 120, conversion: 'dsd-to-pcm' }) }
      }
      t.after(() => { globalThis.fetch = original })
      const player = new MusicPlayer({ songFadeEnabled: false, bgmEnabled: false })
      assert.equal(player.state.decoderAvailable, false, 'no capabilities probe is required')
      await player.play(source.id, [source])
      const audio = env.instances[1]
      assert.equal(audio.src, `/api/decoded-audio/${source.id}`)
      assert.equal(player.state.transport, 'playing')
      audio.currentTime = 37
      audio.dispatchEvent(new Event('timeupdate'))
      await player.toggle()
      assert.equal(audio.paused, true)
      assert.equal(player.state.transport, 'paused')
      await player.toggle()
      assert.equal(player.state.transport, 'playing')
      assert.equal(player.state.currentTime, 37)
      assert.equal(calls.length, 1, 'resume reuses the prepared browser source')
      assert.equal(calls[0].options.method, 'POST')
      assert.equal(env.instances.length, 2, 'raw DSD is never opened as a second source')
      player.dispose()
    })
  }

  test(`late browser ${format} preparation cannot start audio or replace the next track's duration`, async (t) => {
    const env = environment(t)
    const original = globalThis.fetch
    const source = dsdTrack(format)
    let release, signal
    globalThis.fetch = (url, options) => {
      assert.equal(url, `/api/audio/prepare/${source.id}`)
      signal = options.signal
      return new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({ audioUrl: `/api/decoded-audio/${source.id}`, duration: 999 }) }) })
    }
    t.after(() => { globalThis.fetch = original })
    const player = new MusicPlayer({ songFadeEnabled: false, bgmEnabled: false })
    const playing = player.play(source.id, [source, track('next')])
    await settle()
    assert.equal(player.state.loading, true)
    await player.play('next')
    assert.equal(signal.aborted, true)
    const duration = player.state.duration
    release()
    await playing
    assert.equal(player.state.currentTrack.id, 'next')
    assert.equal(player.state.duration, duration, 'a stale decoded result cannot overwrite current metadata')
    assert.equal(player.state.transport, 'playing')
    assert.equal(env.instances.length, 2)
    assert.equal(env.instances[1].src, '/api/audio/next')
    player.dispose()
  })

  test(`browser ${format} reports missing FFmpeg without falling back to raw DSD`, async (t) => {
    const env = environment(t)
    const original = globalThis.fetch
    // An old or inconsistent browser hint must never allow raw DSD fallback.
    const source = { ...dsdTrack(format, true), format: 'Unknown', browserPlayable: true }
    const calls = []
    globalThis.fetch = async (url) => {
      calls.push(url)
      return { ok: false, status: 503, json: async () => ({ error: '未检测到 FFmpeg' }) }
    }
    t.after(() => { globalThis.fetch = original })
    const player = new MusicPlayer({ songFadeEnabled: false, bgmEnabled: false })
    await player.play(source.id, [source])
    assert.deepEqual(calls, [`/api/audio/prepare/${source.id}`])
    assert.equal(player.state.transport, 'error')
    assert.match(player.state.error, /FFmpeg/)
    assert.equal(env.instances.length, 1, 'no HTMLAudio source is created for raw DSD')
    player.dispose()
  })

  test(`CoreAudio ${format} uses local output and retains position across pause and resume`, async (t) => {
    const env = environment(t)
    const native = nativeFetch(t)
    const player = new MusicPlayer({ songFadeEnabled: false, bgmEnabled: false })
    const source = dsdTrack(format, true)
    await player.setBackend('coreaudio', '42')
    await player.play(source.id, [source])
    assert.equal(player.state.transport, 'playing')
    native.state.currentTime = 37
    await env.advance(250)
    await player.toggle()
    assert.equal(player.state.transport, 'paused')
    assert.equal(player.state.currentTime, 37)
    await player.toggle()
    assert.equal(player.state.transport, 'playing')
    assert.equal(player.state.currentTime, 37)
    assert.equal(native.calls.filter((call) => call.action === 'play').length, 2)
    assert.ok(native.calls.some((call) => call.action === 'pause'))
    assert.equal(native.state.trackId, source.id)
    assert.equal(native.state.deviceId, '42')
    assert.equal(env.instances.length, 1, 'CoreAudio never creates an HTMLAudio song')
    player.dispose()
    await settle()
  })

  test(`cancelled CoreAudio ${format} cannot be restored by a late play response`, async (t) => {
    const env = environment(t)
    const native = nativeFetch(t)
    const request = globalThis.fetch
    let release
    globalThis.fetch = async (url, options) => {
      const response = await request(url, options)
      if (url === '/api/output/command' && JSON.parse(options.body).action === 'play') {
        const result = await response.json()
        return new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => result }) })
      }
      return response
    }
    const player = new MusicPlayer({ songFadeEnabled: false, bgmEnabled: false })
    const source = dsdTrack(format)
    await player.setBackend('coreaudio')
    const playing = player.play(source.id, [source])
    await settle()
    assert.equal(player.state.loading, true)
    player.stop()
    release()
    await playing
    assert.equal(player.state.transport, 'idle')
    assert.equal(player.state.playing, false)
    assert.equal(native.state.playing, false)
    assert.equal(native.calls.at(-1).action, 'stop')
    assert.equal(env.instances.length, 1)
    player.dispose()
    await settle()
  })

  test(`CoreAudio ${format} reports decoder failure without a browser fallback`, async (t) => {
    const env = environment(t)
    nativeFetch(t)
    const request = globalThis.fetch
    globalThis.fetch = async (url, options) => {
      if (url === '/api/output/command' && JSON.parse(options.body).action === 'play')
        return { ok: false, status: 503, json: async () => ({ error: '未检测到 FFmpeg' }) }
      return request(url, options)
    }
    const player = new MusicPlayer({ songFadeEnabled: false, bgmEnabled: false })
    const source = dsdTrack(format)
    await player.setBackend('coreaudio')
    await player.play(source.id, [source])
    assert.equal(player.state.transport, 'error')
    assert.match(player.state.error, /FFmpeg/)
    assert.equal(player.state.backend, 'coreaudio')
    assert.equal(env.instances.length, 1)
    player.dispose()
    await settle()
  })
}
