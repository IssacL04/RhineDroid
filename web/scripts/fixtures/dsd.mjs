/**
 * Original, deterministic test signals: 440 Hz left / 880 Hz right, synthesized
 * directly into one-bit DSD with a first-order sigma-delta accumulator. No music,
 * downloaded media, or user library content is used. These are transport test
 * fixtures, not reference-quality DSD mastering or hardware playback samples.
 *
 * DSF uses little-endian chunk sizes INCLUDING each 12-byte chunk header, a
 * 28-byte DSD header, 52-byte fmt chunk, and channel-planar 4096-byte blocks.
 * Its bit-order field is 1 for LSB-first or 8 for MSB-first; final blocks are
 * padded independently per channel and sampleCount excludes that padding.
 * DSDIFF uses big-endian chunk sizes EXCLUDING headers, even-byte chunk padding,
 * FRM8/DSD form, PROP/SND properties and MSB-first channel-interleaved DSD bytes.
 *
 * Format interpretation cross-checked against the primary FFmpeg demuxers:
 * https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/dsfdec.c
 * https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/iff.c
 * This file is an independent generator, not copied FFmpeg implementation.
 */

export const DSD_RATES = [2_822_400, 5_644_800, 11_289_600]

const reverseBits = Uint8Array.from({ length: 256 }, (_, value) => {
  let reversed = 0
  for (let bit = 0; bit < 8; bit++) reversed = (reversed << 1) | ((value >> bit) & 1)
  return reversed
})

function dffChunk(id, payload) {
  const header = Buffer.alloc(12)
  header.write(id, 0, 4, 'ascii')
  header.writeBigUInt64BE(BigInt(payload.length), 4)
  return Buffer.concat([header, payload, Buffer.alloc(payload.length % 2)])
}

function dsfFile(channelBytes, { dsdRate, sampleCount, bitOrder, blockSize }) {
  const blocks = Math.ceil(channelBytes[0].length / blockSize)
  const payload = Buffer.alloc(blocks * blockSize * channelBytes.length)
  for (let block = 0; block < blocks; block++) {
    for (let channel = 0; channel < channelBytes.length; channel++) {
      const source = channelBytes[channel].subarray(block * blockSize, (block + 1) * blockSize)
      const offset = (block * channelBytes.length + channel) * blockSize
      for (let index = 0; index < source.length; index++) {
        payload[offset + index] = bitOrder === 'lsb' ? reverseBits[source[index]] : source[index]
      }
    }
  }
  const header = Buffer.alloc(92)
  header.write('DSD ', 0, 4, 'ascii')
  header.writeBigUInt64LE(28n, 4)
  header.writeBigUInt64LE(BigInt(header.length + payload.length), 12)
  header.write('fmt ', 28, 4, 'ascii')
  header.writeBigUInt64LE(52n, 32)
  header.writeUInt32LE(1, 40) // format version
  header.writeUInt32LE(0, 44) // uncompressed DSD
  header.writeUInt32LE(2, 48) // stereo channel type
  header.writeUInt32LE(channelBytes.length, 52)
  header.writeUInt32LE(dsdRate, 56)
  header.writeUInt32LE(bitOrder === 'lsb' ? 1 : 8, 60)
  header.writeBigUInt64LE(BigInt(sampleCount), 64)
  header.writeUInt32LE(blockSize, 72)
  header.write('data', 80, 4, 'ascii')
  header.writeBigUInt64LE(BigInt(12 + payload.length), 84)
  return Buffer.concat([header, payload])
}

function dffFile(channelBytes, dsdRate) {
  const version = Buffer.alloc(4)
  version.writeUInt32BE(0x01050000)
  const rate = Buffer.alloc(4)
  rate.writeUInt32BE(dsdRate)
  const channels = Buffer.alloc(10)
  channels.writeUInt16BE(channelBytes.length)
  channels.write('SLFTSRGT', 2, 8, 'ascii')
  const compressionName = Buffer.from('not compressed', 'ascii')
  const compression = Buffer.concat([Buffer.from('DSD ', 'ascii'), Buffer.from([compressionName.length]), compressionName])
  const properties = Buffer.concat([
    Buffer.from('SND ', 'ascii'),
    dffChunk('FS  ', rate),
    dffChunk('CHNL', channels),
    dffChunk('CMPR', compression),
  ])
  const payload = Buffer.alloc(channelBytes[0].length * channelBytes.length)
  for (let index = 0; index < channelBytes[0].length; index++) {
    for (let channel = 0; channel < channelBytes.length; channel++) payload[index * channelBytes.length + channel] = channelBytes[channel][index]
  }
  return dffChunk('FRM8', Buffer.concat([
    Buffer.from('DSD ', 'ascii'),
    dffChunk('FVER', version),
    dffChunk('PROP', properties),
    dffChunk('DSD ', payload),
  ]))
}

/**
 * Returns file bytes plus exact canonical MSB-first per-channel DSD bytes.
 * `channelBytes` contains no DSF block padding and can be compared directly to
 * DSD bits recovered from DoP. `sampleCount` counts one-bit samples per channel.
 * Duration defaults to 0.1 s, rounded down to complete bytes. Set sampleCount
 * explicitly (a multiple of 8) to test odd byte counts or block boundaries.
 */
export function createDsdFixture({
  format = 'dsf',
  dsdRate = DSD_RATES[0],
  duration = 0.1,
  sampleCount = Math.floor(dsdRate * duration / 8) * 8,
  bitOrder = format === 'dsf' ? 'lsb' : 'msb',
  blockSize = 4096,
} = {}) {
  if (!['dsf', 'dff'].includes(format)) throw new Error('Fixture format must be dsf or dff')
  if (!DSD_RATES.includes(dsdRate)) throw new Error('Fixture rate must be DSD64, DSD128, or DSD256')
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 8 || sampleCount % 8 || sampleCount > dsdRate * 10) throw new Error('Fixture sampleCount must be a multiple of 8 within 10 seconds')
  if (!['lsb', 'msb'].includes(bitOrder) || (format === 'dff' && bitOrder !== 'msb')) throw new Error('Invalid fixture bit order')
  if (!Number.isSafeInteger(blockSize) || blockSize < 1 || blockSize > 65536) throw new Error('Invalid fixture block size')
  const frequencies = [440, 880]
  const channelBytes = frequencies.map((frequency) => {
    const bytes = Buffer.alloc(sampleCount / 8)
    let accumulator = 0
    for (let sample = 0; sample < sampleCount; sample++) {
      accumulator += 0.3 * Math.sin(2 * Math.PI * frequency * sample / dsdRate)
      const bit = accumulator >= 0 ? 1 : 0
      accumulator -= bit ? 1 : -1
      bytes[sample >> 3] |= bit << (7 - (sample & 7))
    }
    return bytes
  })
  const buffer = format === 'dsf'
    ? dsfFile(channelBytes, { dsdRate, sampleCount, bitOrder, blockSize })
    : dffFile(channelBytes, dsdRate)
  return {
    buffer, format, dsdRate, sampleCount, bitOrder, blockSize,
    channels: channelBytes.length,
    duration: sampleCount / dsdRate,
    channelBytes,
    frequencies,
    codec: format === 'dff' ? 'dsd_msbf' : bitOrder === 'lsb' ? 'dsd_lsbf_planar' : 'dsd_msbf_planar',
  }
}
