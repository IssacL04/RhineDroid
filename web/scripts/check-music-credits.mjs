import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MusicLibraryStore } from './music-library.mjs'
import { createMusicServer } from './music-server.mjs'

async function fixture(t, count = 1) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-credits-test-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'music')
  for (let i = 0; i < count; i++) {
    const folder = path.join(root, `Album ${i}`)
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(path.join(folder, '01.flac'), 'synthetic metadata fixture')
  }
  const store = await new MusicLibraryStore({ dataDir: path.join(directory, 'data'), defaultRoots: [root],
    metadataParser: async (file) => ({ common: { album: path.basename(path.dirname(file)), title: path.basename(file), artist: 'Fixture Artist', composer: ['Local Composer'] }, format: { duration: 200 } }),
    fetcher: async () => { throw new Error('Tests must never contact remote services') },
  }).init()
  await store.scan()
  return { directory, root, store }
}

const success = (album, name = 'Fixture Producer') => ({ status: 'matched', checkedAt: new Date().toISOString(), matchedTracks: album.tracks.length, totalTracks: album.tracks.length,
  credits: album.tracks.map((track) => ({ name, role: '混音', source: 'QQ Music', trackTitle: track.title, trackId: track.id, url: 'https://y.qq.com/n/ryqq/songDetail/fixtureSong' })),
})

test('local roles and online credits coexist, persist, and stay out of private metadata transport', async (t) => {
  const { store } = await fixture(t)
  let calls = 0
  store.creditsProvider = { lookup: async (album, options) => {
    calls++
    assert.equal(album.tracks[0]._path, undefined)
    assert.equal(album.tracks[0]._common.album, 'Album 0')
    options.onProgress({ completed: 1, total: 1 })
    return success(album)
  } }
  await store.updateCredits()
  const album = store.snapshot().albums[0]
  assert.deepEqual(album.producers.map((person) => [person.name, person.role, person.source]), [['Local Composer', '作曲', 'local'], ['Fixture Producer', '混音', 'QQ Music']])
  assert.equal(album.creditsLookup.status, 'matched')
  assert.equal(store.snapshot().credits.updated, 1)
  assert.equal(album.tracks[0]._common, undefined)
  await store.updateCredits()
  assert.equal(calls, 1, 'ordinary missing-data queries reuse successful results')
  await store.scan()
  assert.equal(store.snapshot().albums[0].producers.length, 2)
  const reloaded = await new MusicLibraryStore({ dataDir: store.dataDir }).init()
  assert.deepEqual(reloaded.snapshot().albums[0].producers, album.producers)
})

test('failed explicit refresh preserves useful credits and reports the query failure', async (t) => {
  const { store } = await fixture(t)
  store.creditsProvider = { lookup: async (album) => success(album) }
  await store.updateCredits()
  store.creditsProvider = { lookup: async () => { throw new Error('temporary timeout') } }
  await store.updateCredits({ force: true })
  const result = store.snapshot()
  assert.equal(result.credits.failed, 1)
  assert.equal(result.albums[0].creditsLookup.status, 'error')
  assert.match(result.albums[0].creditsLookup.error, /timeout/)
  assert.ok(result.albums[0].producers.some((person) => person.source === 'QQ Music'))
  assert.equal(result.credits.running, false)
})

test('partial refresh replaces only successfully refreshed track credits', async (t) => {
  const { store, root } = await fixture(t)
  await fs.writeFile(path.join(root, 'Album 0', '02.flac'), 'second fixture')
  await store.scan()
  store.creditsProvider = { lookup: async (album) => success(album, 'Previous') }
  await store.updateCredits()
  store.creditsProvider = { lookup: async (album) => ({ ...success(album, 'New'), status: 'partial', matchedTracks: 1, credits: success(album, 'New').credits.slice(0, 1) }) }
  await store.updateCredits({ force: true })
  const album = store.snapshot().albums[0]
  assert.deepEqual(album.producers.filter((person) => person.source === 'QQ Music').map((person) => person.name).sort(), ['New', 'Previous'])
  assert.equal(album.creditsLookup.status, 'partial')
})

test('rate limiting stops remaining albums, keeps the partial data and returns the cooldown', async (t) => {
  const { store } = await fixture(t, 3)
  let calls = 0
  const retryAt = new Date(Date.now() + 60_000).toISOString()
  store.creditsProvider = { lookup: async (album) => { calls++; return { ...success(album), status: 'partial', error: 'HTTP 429', retryAt } } }
  await store.updateCredits()
  assert.equal(calls, 1)
  const result = store.snapshot()
  assert.equal(result.credits.completed, 1)
  assert.match(result.credits.error, /剩余 2 张/)
  assert.equal(result.albums[0].creditsLookup.retryAt, retryAt)
  assert.equal(result.albums[1].creditsLookup, undefined)
})

test('late results cannot attach to changed tracks or a removed root', async (t) => {
  const { store } = await fixture(t)
  let finish
  const gate = new Promise((resolve) => { finish = resolve })
  store.creditsProvider = { lookup: async (album) => { await gate; return success(album) } }
  const pending = store.updateCredits()
  await Promise.resolve()
  store.index.albums[0].tracks[0].title = 'New identity'
  finish()
  await pending
  assert.equal(store.snapshot().albums[0].creditsLookup, undefined)
  assert.ok(store.snapshot().albums[0].producers.every((person) => person.source !== 'QQ Music'))
  let finishSecond
  const secondGate = new Promise((resolve) => { finishSecond = resolve })
  store.creditsProvider = { lookup: async (album) => { await secondGate; return success(album) } }
  const second = store.updateCredits()
  await Promise.resolve()
  await store.updateConfig({ roots: [] })
  finishSecond()
  await second
  assert.equal(store.index.albums[0].creditsLookup, undefined)
})

test('partial network failures can resume after cooldown without forcing successful tracks', async (t) => {
  const { store } = await fixture(t)
  store.index.albums[0].creditsLookup = { source: 'QQ Music', status: 'partial', checkedAt: new Date(Date.now() - 11 * 60_000).toISOString(), retryAt: new Date(Date.now() - 60_000).toISOString(), error: 'temporary timeout' }
  let calls = 0
  store.creditsProvider = { lookup: async (album, options) => { calls++; assert.equal(options.force, false); return success(album) } }
  await store.updateCredits()
  assert.equal(calls, 1)
  assert.equal(store.snapshot().albums[0].creditsLookup.status, 'matched')
})

test('disk write failures never claim new credits were saved successfully', async (t) => {
  const { store } = await fixture(t)
  store.creditsProvider = { lookup: async (album) => success(album) }
  store.saveIndex = async () => { throw new Error('ENOSPC') }
  await store.updateCredits()
  const result = store.snapshot()
  assert.equal(result.credits.updated, 0)
  assert.equal(result.credits.failed, 1)
  assert.equal(result.albums[0].creditsLookup.status, 'error')
  assert.match(result.albums[0].creditsLookup.error, /缓存写入失败/)
  assert.ok(result.albums[0].producers.every((person) => person.source === 'local'))
})

test('a simultaneous scan retains newly completed credits for unchanged tracks', async (t) => {
  const { store } = await fixture(t)
  let releaseScan, scanRead
  const scanGate = new Promise((resolve) => { releaseScan = resolve })
  const readStarted = new Promise((resolve) => { scanRead = resolve })
  const read = store.readAlbum.bind(store)
  store.readAlbum = async (...args) => { const value = await read(...args); scanRead(); await scanGate; return value }
  const scan = store.scan()
  await readStarted
  store.creditsProvider = { lookup: async (album) => success(album) }
  await store.updateCredits()
  releaseScan()
  await scan
  assert.equal(store.snapshot().albums[0].creditsLookup.status, 'matched')
  assert.equal(store.snapshot().albums[0].producers.filter((person) => person.source === 'QQ Music').length, 1)
})

test('credits HTTP endpoint is manual, contact-free, validated and protected by Origin checks', async (t) => {
  const { store, directory } = await fixture(t)
  let calls = 0
  store.creditsProvider = { lookup: async (album) => { calls++; return success(album) } }
  const { server } = await createMusicServer({ store, distDir: directory, autoScan: false })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)) })
  const url = `http://127.0.0.1:${server.address().port}/api/library/credits`
  const post = (body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  assert.equal(calls, 0)
  assert.equal((await post({ force: 'yes' })).status, 400)
  assert.equal((await post({ albumIds: [123] })).status, 400)
  assert.equal((await post({}, { Origin: 'https://unrelated.example' })).status, 403)
  assert.equal((await post({}, { 'Content-Type': 'text/plain' })).status, 415)
  assert.equal(calls, 0)
  const response = await post({ albumIds: [store.snapshot().albums[0].id] })
  assert.equal(response.status, 202)
  await store.creditsPromise
  assert.equal(calls, 1)
  assert.equal(store.snapshot().albums[0].creditsLookup.source, 'QQ Music')
})
