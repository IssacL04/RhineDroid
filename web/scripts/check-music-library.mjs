import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { MusicLibraryStore } from './music-library.mjs'
import { createMusicServer, parseRange } from './music-server.mjs'

async function fixture(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rhinedroid-test-'))
  t.after(() => fs.rm(temporary, { force: true, recursive: true }))
  const root = path.join(temporary, 'music')
  await fs.mkdir(root)
  const store = await new MusicLibraryStore({ dataDir: path.join(temporary, 'index'), defaultRoots: [root], ...options }).init()
  return { temporary, root, store }
}

async function fakeAlbum(root, name = 'Album', files = ['01.flac']) {
  const folder = path.join(root, name)
  await fs.mkdir(folder, { recursive: true })
  for (const file of files) await fs.writeFile(path.join(folder, file), Buffer.from('only a temporary metadata fixture'))
  return folder
}

function wavFixture() {
  const sampleRate = 48000
  const dataSize = sampleRate * 2
  const bytes = Buffer.alloc(44 + dataSize)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(dataSize, 40)
  return bytes
}

test('real WAV parsing exposes duration, lossless technical metadata, and byte-accurate Range playback', async (t) => {
  const { root, store, temporary } = await fixture(t)
  const folder = await fakeAlbum(root, 'Test WAV', [])
  const bytes = wavFixture()
  await fs.writeFile(path.join(folder, '1-01 Test.wav'), bytes)
  await store.scan()
  const track = store.snapshot().albums[0].tracks[0]
  assert.equal(track.format, 'WAV')
  assert.equal(track.duration, 1)
  assert.equal(track.sampleRate, 48000)
  assert.equal(track.bitsPerSample, 16)
  assert.equal(track.lossless, true)
  assert.equal(track.discNumber, 1)
  assert.equal(track.trackNumber, 1)
  assert.equal(track.browserPlayable, true)
  assert.equal('_path' in track, false)
  const distDir = path.join(temporary, 'dist')
  await fs.mkdir(distDir)
  await fs.writeFile(path.join(distDir, 'index.html'), '<h1>fixture</h1>')
  const { server } = await createMusicServer({ store, distDir, autoScan: false })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const ranged = await fetch(`${origin}${track.audioUrl}`, { headers: { Range: 'bytes=0-43' } })
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers.get('content-range'), `bytes 0-43/${bytes.length}`)
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(0, 44))
  const suffix = await fetch(`${origin}${track.audioUrl}`, { headers: { Range: 'bytes=-9' } })
  assert.equal(suffix.status, 206)
  assert.equal((await suffix.arrayBuffer()).byteLength, 9)
  const invalid = await fetch(`${origin}${track.audioUrl}`, { headers: { Range: `bytes=${bytes.length}-` } })
  assert.equal(invalid.status, 416)
  assert.equal(invalid.headers.get('content-range'), `bytes */${bytes.length}`)
  assert.equal((await fetch(`${origin}/api/audio/not-indexed`)).status, 404)
  assert.equal((await fetch(`${origin}/api/library`, { headers: { Origin: 'https://unrelated.example' } })).status, 403)
  assert.equal((await fetch(`${origin}/api/library/scan`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415)
  assert.equal((await fetch(`${origin}/api/foobar/player`)).status, 503)
  const library = await (await fetch(`${origin}/api/library`)).json()
  assert.equal(library.albums.length, 1)
  store.introductionProvider = { lookup: async () => ({ status: 'matched', description: 'A synthetic encyclopedia introduction.', descriptionSource: { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Test_fixture' } }) }
  const introduction = await fetch(`${origin}/api/library/introductions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ albumIds: [library.albums[0].id], force: true }) })
  assert.equal(introduction.status, 202, 'introduction updates must not require a MusicBrainz contact')
  await store.introductionsPromise
  assert.equal(store.snapshot().introductions.updated, 1)
  assert.equal(store.snapshot().albums[0].description, 'A synthetic encyclopedia introduction.')
  const malformedUpdate = await fetch(`${origin}/api/library/introductions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"force":"yes"}' })
  assert.equal(malformedUpdate.status, 400)
})

test('incremental scan detects additions/removals, caches unchanged tags, and preserves a disconnected root', async (t) => {
  let reads = 0
  const { root, store } = await fixture(t, { metadataParser: async () => { reads += 1; return { common: { album: 'Album', artist: 'Artist', genre: ['Mandopop'] }, format: { duration: 10 } } } })
  const first = await fakeAlbum(root, 'First')
  await store.scan()
  assert.equal(reads, 1)
  const firstId = store.snapshot().albums[0].id
  await store.scan()
  assert.equal(reads, 1, 'unchanged metadata should be read from the cached index')
  await fakeAlbum(root, 'Second')
  await store.scan()
  assert.equal(store.snapshot().albums.length, 2)
  assert.equal(reads, 2)
  await fs.rm(first, { recursive: true })
  await store.scan()
  assert.equal(store.snapshot().albums.length, 1)
  assert.ok(store.snapshot().albums.every((album) => album.id !== firstId))
  const disconnected = `${root}-disconnected`
  await fs.rename(root, disconnected)
  await store.scan()
  assert.equal(store.snapshot().albums.length, 1)
  assert.equal(store.snapshot().roots[0].status, 'offline')
  assert.equal(store.snapshot().albums[0].offline, true)
  await fs.rename(disconnected, root)
  await store.scan()
  assert.equal(store.snapshot().albums[0].offline, false)
})

test('v3 metadata upgrades from the saved index without source reparsing and derives v4 playback fields', async (t) => {
  let reads = 0
  const metadataParser = async (file) => {
    reads += 1
    return { common: { album: 'Cached album', artist: 'Cached artist', genre: ['Jazz'], composer: ['Cached composer'] }, format: { codec: file.endsWith('.dsf') ? 'DSD' : file.endsWith('.ape') ? 'APE' : 'FLAC', duration: 123, bitsPerSample: 24, sampleRate: 96000, numberOfChannels: 2, lossless: true } }
  }
  const { root, store } = await fixture(t, { metadataParser })
  const folder = await fakeAlbum(root, 'Cached', ['01.flac', '02.dsf'])
  await store.scan()
  const before = JSON.parse(JSON.stringify(store.snapshot()))
  const sourceBefore = await fs.readFile(path.join(folder, '01.flac'))
  for (const track of store.index.albums[0].tracks) {
    track._metadataVersion = 3
    if (track.format === 'DSF') track.localDecodable = false
  }
  await store.saveIndex()
  reads = 0
  const restored = await new MusicLibraryStore({ dataDir: store.dataDir, metadataParser }).init()
  assert.deepEqual(JSON.parse(JSON.stringify(restored.snapshot().albums)), before.albums, 'cached library remains available before the startup scan')
  await restored.scan()
  assert.equal(reads, 0, 'v3 contains the same parsed tag schema; do not re-read source tags merely for v4 routes')
  assert.deepEqual(JSON.parse(JSON.stringify(restored.snapshot().albums)), before.albums, 'technical fields, local credits and album identity survive migration')
  assert.ok(restored.index.albums[0].tracks.every((track) => track._metadataVersion === 4))
  const snapshot = restored.snapshot()
  const [flac, dsd] = snapshot.albums[0].tracks
  assert.equal(flac.decodedAudioUrl, `/api/decoded-audio/${flac.id}`)
  assert.equal(flac.localDecodable, true)
  assert.equal(dsd.localDecodable, true)
  assert.equal(dsd.browserPlayable, false)
  for (const track of snapshot.albums[0].tracks) {
    for (const key of ['_path', '_fingerprint', '_common', '_embeddedCover', '_metadataVersion']) assert.equal(key in track, false, `${key} remains private`)
  }
  assert.deepEqual(await fs.readFile(path.join(folder, '01.flac')), sourceBefore, 'migration never rewrites the source')
  await fs.writeFile(path.join(folder, '03.ape'), 'new APE metadata fixture')
  await restored.scan()
  assert.equal(reads, 1, 'newly supported formats still require their own metadata read')
  assert.equal(restored.snapshot().albums[0].tracks.find((track) => track.format === 'APE').codec, 'APE')
  assert.equal(restored.snapshot().albums[0].tracks.find((track) => track.format === 'APE').localDecodable, true)
  await fs.appendFile(path.join(folder, '01.flac'), 'changed source')
  await restored.scan()
  assert.equal(reads, 2, 'changed source fingerprints are not hidden by schema compatibility')
  restored.index.albums[0].tracks.find((track) => track.format === 'FLAC')._metadataVersion = 2
  await restored.scan()
  assert.equal(reads, 3, 'pre-v3 schemas still reparse the missing credits metadata')
})

test('folder covers override embedded art; removing a cover reveals cached or newly extracted embedded art', async (t) => {
  const embedded = Buffer.from('embedded-test-image')
  const { root, store } = await fixture(t, { metadataParser: async (_file, options) => ({ common: { picture: options.skipCovers ? [] : [{ format: 'image/png', type: 'Cover (front)', data: embedded }] }, format: {} }) })
  const folder = await fakeAlbum(root)
  const cover = path.join(folder, 'Cover.png')
  await fs.writeFile(cover, 'folder-test-image')
  await store.scan()
  const album = store.snapshot().albums[0]
  assert.equal(store.artworkFile(album.id).path, cover)
  assert.equal(store.artworkFile(album.id).embedded, false)
  store.index.albums[0].tracks[0]._metadataVersion = 3
  await fs.unlink(cover)
  await store.scan()
  assert.equal(store.artworkFile(album.id).embedded, true)
  assert.deepEqual(await fs.readFile(store.artworkFile(album.id).path), embedded)
})

test('manual genres survive rescans and online refresh; editing the rules needs no audio rewrite', async (t) => {
  const { root, store } = await fixture(t, { metadataParser: async () => ({ common: { genre: ['国语流行音乐'], album: 'Album', artist: 'Artist' }, format: {} }) })
  await fakeAlbum(root)
  await store.scan()
  const album = store.snapshot().albums[0]
  assert.equal(album.genreId, 'mandopop')
  await store.updateRules({ ...store.rules, albumOverrides: { [album.id]: 'jazz' } })
  store.index.albums[0]._onlineGenres = ['Rock']
  assert.equal(store.snapshot().albums[0].genreId, 'jazz')
  await store.scan()
  assert.equal(store.snapshot().albums[0].genreId, 'jazz')
  const rulesFile = path.join(store.dataDir, 'genre-rules.json')
  const rules = JSON.parse(await fs.readFile(rulesFile, 'utf8'))
  rules.albumOverrides[album.id] = 'classical'
  await fs.writeFile(rulesFile, JSON.stringify(rules))
  await store.reloadRules()
  assert.equal(store.snapshot().albums[0].genreId, 'classical')
  assert.ok(await fs.stat(`${rulesFile}.backup`))
})

test('DSD is indexed without promising browser playback, and overlapping scans coalesce', async (t) => {
  let release
  let reads = 0
  const gate = new Promise((resolve) => { release = resolve })
  const { root, store } = await fixture(t, { metadataParser: async () => { reads += 1; await gate; return { common: {}, format: { codec: 'DSD', sampleRate: 2822400 } } } })
  await fakeAlbum(root, 'DSD', ['01.dsf', '02.dff'])
  const first = store.scan()
  const second = store.scan()
  release()
  await Promise.all([first, second])
  assert.equal(reads, 2)
  assert.deepEqual(store.snapshot().albums[0].tracks.map((track) => track.browserPlayable), [false, false])
  assert.deepEqual(store.snapshot().albums[0].tracks.map((track) => track.localDecodable), [true, true])
  const reloaded = await new MusicLibraryStore({ dataDir: store.dataDir }).init()
  assert.equal(reloaded.snapshot().albums.length, 1, 'cached library is available before another scan')
  assert.deepEqual(reloaded.snapshot().albums[0].tracks.map((track) => track.localDecodable), [true, true], 'DSF and DFF are immediately available through local decoding after startup')
})

test('ambiguous online matches never assign guessed production credits or genres', async (t) => {
  let calls = 0
  const candidate = { title: 'Album', id: 'ad934c98-0bbd-4060-8ebf-c5a23d2f2b6b', score: 100, 'track-count': 1, 'artist-credit': [{ name: 'Artist' }] }
  const { root, store } = await fixture(t, {
    metadataParser: async () => ({ common: { album: 'Album', artist: 'Artist', genre: ['Jazz'] }, format: {} }),
    musicBrainzContact: 'test@example.invalid',
    fetcher: async () => { calls += 1; return { ok: true, json: async () => ({ releases: [candidate, { ...candidate, id: 'bd934c98-0bbd-4060-8ebf-c5a23d2f2b6b' }] }) } },
  })
  await fakeAlbum(root)
  await store.scan()
  await store.enrich()
  const album = store.snapshot().albums[0]
  assert.equal(calls, 1)
  assert.equal(album.online.status, 'uncertain')
  assert.equal(album.genreId, 'jazz')
  assert.deepEqual(album.producers, [])
})

test('album introductions follow matched release-group links, retain attribution, and never use local comments', async (t) => {
  const releaseId = 'ad934c98-0bbd-4060-8ebf-c5a23d2f2b6b'
  const groupId = 'bd934c98-0bbd-4060-8ebf-c5a23d2f2b6b'
  const requests = []
  const { root, store } = await fixture(t, {
    metadataParser: async () => ({ common: { album: 'Album', artist: 'Artist', musicbrainz_albumid: releaseId, comment: [{ text: 'A mastering note, not an introduction.' }] }, format: { lossless: false, codec: 'MPEG-4/AAC' } }),
    musicBrainzContact: 'test@example.invalid',
    fetcher: async (url) => {
      requests.push({ url: url.href, time: Date.now() })
      let result
      if (url.pathname === `/ws/2/release/${releaseId}`) result = { 'release-group': { id: groupId }, genres: [{ name: 'Jazz', count: 2 }], relations: [], media: [] }
      else if (url.pathname === `/ws/2/release-group/${groupId}`) result = { relations: [{ type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q123' } }] }
      else if (url.hostname === 'www.wikidata.org') result = { entities: { Q123: { sitelinks: { zhwiki: { title: '测试专辑' } } } } }
      else if (url.hostname === 'zh.wikipedia.org') result = { query: { pages: [{ title: '测试专辑', extract: 'This is an attributed online fixture introduction.' }] } }
      else throw new Error(`Unexpected network target ${url}`)
      return { ok: true, json: async () => result }
    },
  })
  await fakeAlbum(root, 'Album', ['01.m4a'])
  await store.scan()
  const before = store.snapshot().albums[0]
  assert.equal(before.description, undefined)
  assert.equal(before.localNote, 'A mastering note, not an introduction.')
  assert.equal(before.tracks[0].lossless, false)
  await store.updateRules({ ...store.rules, albumOverrides: { [before.id]: 'classical' } })
  await store.enrich()
  const after = store.snapshot().albums[0]
  assert.equal(after.description, 'This is an attributed online fixture introduction.')
  assert.equal(after.descriptionSource.name, '维基百科')
  assert.ok(after.descriptionSource.url.startsWith('https://zh.wikipedia.org/wiki/'))
  assert.equal(after.online.descriptionStatus, 'available')
  assert.equal(after.genreId, 'classical')
  assert.equal(requests.length, 4)
  for (let i = 1; i < requests.length; i += 1) assert.ok(requests[i].time - requests[i - 1].time >= 1000)
  await store.enrich()
  assert.equal(requests.length, 4, 'automatic enrichment does not refetch a cached match')
  assert.equal(store.enrichPromise, null, 'empty enrichment queues do not leave a stale in-flight promise')
})

test('Range validation rejects malformed and multipart requests and clips an excessive end', () => {
  assert.equal(parseRange('bytes=0-2,4-5', 10), false)
  assert.equal(parseRange('bytes=-0', 10), false)
  assert.equal(parseRange('bytes=7-2', 10), false)
  assert.equal(parseRange('bytes=0-', 0), false)
  assert.deepEqual(parseRange('bytes=7-99', 10), { start: 7, end: 9 })
})
