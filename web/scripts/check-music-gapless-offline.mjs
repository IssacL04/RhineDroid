// Real browser audio rendering; OfflineAudioContext never connects to a device.
// PLAYWRIGHT_MODULE may point to an existing Playwright install; no downloads.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import ts from 'typescript'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] })
try {
  const page = await browser.newPage()
  const source = await fs.readFile(new URL('../src/music-browser-gapless.ts', import.meta.url), 'utf8')
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const results = await page.evaluate(async javascript => {
    const { BrowserGaplessPlayer } = await import(URL.createObjectURL(new Blob([javascript], { type: 'text/javascript' })))
    function wave(frames, sampleRate, phase = 0, constant) {
      const data = new ArrayBuffer(44 + frames * 4), view = new DataView(data)
      const text = (at, value) => [...value].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)))
      text(0, 'RIFF'); view.setUint32(4, data.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true)
      view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true)
      view.setUint16(32, 4, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, frames * 4, true)
      for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < 2; channel++)
        view.setInt16(44 + (frame * 2 + channel) * 2, constant ?? Math.round(Math.sin((frame + phase) * 137 * Math.PI * 2 / sampleRate + channel * .3) * 20000), true)
      return data
    }
    const results = []
    for (const scenario of ['continuous-sine', 'mixed-44100-48000', 'mixed-noninteger-44100-48000', 'mixed-48000-44100', 'cancel-next', 'seek-then-next']) {
      const rate = scenario === 'mixed-48000-44100' ? 44100 : 48000
      const firstRate = scenario.includes('44100-48000') ? 44100 : 48000
      const firstFrames = firstRate / 10 + (scenario.includes('noninteger') ? 1 : 0), secondFrames = Math.round(rate * .06)
      const files = { a: wave(firstFrames, firstRate), b: wave(secondFrames, rate, 4800) }
      const context = new OfflineAudioContext(2, 16000, rate)
      const facade = {
        get currentTime() { return context.currentTime }, sampleRate: context.sampleRate, destination: context.destination,
        createGain: () => context.createGain(), createBufferSource: () => context.createBufferSource(),
        decodeAudioData: data => context.decodeAudioData(data), resume: async () => {}, close: async () => {},
      }
      const reference = { a: await context.decodeAudioData(files.a.slice(0)), b: await context.decodeAudioData(files.b.slice(0)) }
      window.fetch = async (url) => {
        const id = String(url).split('/').at(-1)
        const file = files[id]
        return String(url).includes('/prepare/')
          ? new Response(JSON.stringify({ bytes: file.byteLength, audioUrl: `/pcm/${id}` }))
          : new Response(file.slice(0))
      }
      const boundaries = []
      const engine = new BrowserGaplessPlayer({ progress() {}, boundary: track => boundaries.push(track.id), ended() {} }, facade)
      engine.volume(1)
      await engine.play({ id: 'a' }, 0, new AbortController().signal)
      if (scenario === 'seek-then-next') engine.seek(.03)
      await engine.prepareNext({ id: 'b' })
      if (scenario === 'cancel-next') engine.cancelNext()
      const rendered = await context.startRendering()
      const start = Math.round(.04 * rate), offset = scenario === 'seek-then-next' ? Math.round(.03 * rate) : 0
      const firstLength = reference.a.length - offset, withNext = scenario !== 'cancel-next'
      let maxError = 0, seamError = 0, silenceAfter = 0
      for (let channel = 0; channel < 2; channel++) {
        const actual = rendered.getChannelData(channel), a = reference.a.getChannelData(channel), b = reference.b.getChannelData(channel)
        for (let i = 0; i < actual.length; i++) {
          const frame = i - start
          const expected = frame >= 0 && frame < firstLength ? a[frame + offset]
            : withNext && frame >= firstLength && frame < firstLength + b.length ? b[frame - firstLength] : 0
          const error = Math.abs(actual[i] - expected)
          maxError = Math.max(maxError, error)
          if (Math.abs(frame - firstLength) <= 256) seamError = Math.max(seamError, error)
          if (frame >= firstLength + (withNext ? b.length : 0)) silenceAfter = Math.max(silenceAfter, Math.abs(actual[i]))
        }
      }
      engine.dispose()
      results.push({ scenario, frames: rendered.length, firstLength, secondLength: withNext ? reference.b.length : 0, maxError, seamError, silenceAfter, boundaries })
    }
    return results
  }, javascript)
  for (const result of results) {
    assert.ok(result.maxError < 0.00001, `${result.scenario}: complete PCM mismatch ${result.maxError}`)
    assert.ok(result.seamError < 0.00001, `${result.scenario}: seam mismatch ${result.seamError}`)
    assert.equal(result.silenceAfter, 0)
    assert.deepEqual(result.boundaries, result.scenario === 'cancel-next' ? [] : ['b'])
  }
  console.log(JSON.stringify({ browser: await browser.version(), output: 'OfflineAudioContext only; no audible device', results }, null, 2))
} finally { await browser.close() }
