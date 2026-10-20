import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { findExecutable } from './music-audio.mjs'
import { createDsdFixture, DSD_RATES } from './fixtures/dsd.mjs'

const execute = promisify(execFile)

test('synthetic DSD fixtures are recognized and demuxed without changing any DSD bits', async (t) => {
  const ffprobe = await findExecutable('ffprobe')
  const ffmpeg = await findExecutable('ffmpeg')
  assert.ok(ffprobe && ffmpeg, 'FFmpeg and ffprobe are required for fixture validation')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-dsd-fixtures-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  for (const dsdRate of DSD_RATES) {
    for (const [format, bitOrder] of [['dsf', 'lsb'], ['dsf', 'msb'], ['dff', 'msb']]) {
      await t.test(`${format} ${bitOrder} DSD${dsdRate / 44100}`, async () => {
        const fixture = createDsdFixture({ format, bitOrder, dsdRate })
        const file = path.join(root, `${dsdRate}-${bitOrder}.${format}`)
        await fs.writeFile(file, fixture.buffer)
        const { stdout } = await execute(ffprobe, [
          '-v', 'error', '-select_streams', 'a:0', '-show_streams', '-show_packets',
          '-show_entries', 'stream=codec_name,sample_rate,channels,time_base:packet=duration', '-of', 'json', file,
        ])
        const probe = JSON.parse(stdout)
        const stream = probe.streams[0]
        assert.equal(stream.codec_name, fixture.codec)
        assert.equal(Number(stream.sample_rate), dsdRate / 8)
        assert.equal(stream.channels, 2)
        assert.equal(stream.time_base, `1/${dsdRate / 8}`)
        // DSF's overall probe duration may include block padding. Packet durations
        // in integer DSD-byte ticks are exact and exclude each channel's padding.
        assert.equal(probe.packets.reduce((sum, packet) => sum + packet.duration, 0), fixture.sampleCount / 8)
        assert.notDeepEqual(fixture.channelBytes[0], fixture.channelBytes[1])

        // Explicit stream copy: no decoder, PCM conversion, or audio output.
        const raw = (await execute(ffmpeg, [
          '-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', 'copy', '-f', 'data', '-',
        ], { encoding: 'buffer', maxBuffer: 4 * 1024 ** 2 })).stdout
        const expected = []
        if (format === 'dff') {
          for (let index = 0; index < fixture.channelBytes[0].length; index++) {
            for (const channel of fixture.channelBytes) expected.push(channel[index])
          }
        } else {
          for (let offset = 0; offset < fixture.channelBytes[0].length; offset += 4096) {
            for (const channel of fixture.channelBytes) {
              for (const byte of channel.subarray(offset, offset + 4096)) {
                // Deliberately independent of the generator's lookup table.
                expected.push(bitOrder === 'msb' ? byte : Number.parseInt(byte.toString(2).padStart(8, '0').split('').reverse().join(''), 2))
              }
            }
          }
        }
        assert.deepEqual(raw, Buffer.from(expected))
        assert.deepEqual(await fs.readFile(file), fixture.buffer, 'probe and stream-copy leave the source immutable')
      })
    }
  }
})
