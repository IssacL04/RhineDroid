import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QQCreditsProvider, chooseQQTrack, readQQCredits } from './qq-credits.mjs'

const SEARCH = 'music.search.SearchCgiService'
const metadata = { title: '夜航', artist: '陈小明', album: '远行', duration: 240 }
const candidate = { mid: 'fixtureSong123', name: '夜航', title: '夜航', subtitle: '', artists: ['陈小明'], album: '远行', duration: 240 }
const track = { id: 'fixture-track', title: metadata.title, artist: metadata.artist, duration: metadata.duration, _common: { album: metadata.album } }
const album = { title: '此处是本地分组名', artist: metadata.artist, tracks: [track] }
const groups = { Lst: [
  { Title: '作曲', Type: 6, Producers: [{ Name: '测试甲', Type: 6 }] },
  { Title: '编曲', Type: 8, Producers: [{ Name: '测试乙', Type: 8 }] },
  { Title: '制作人', Type: 9, Producers: [{ Name: '测试甲', Type: 9 }] },
  { Title: '鼓', Type: 99, Producers: [{ Name: '测试丙', Type: 99 }] },
] }
const queue = () => ({ chain: Promise.resolve(), lastStart: -Infinity, retryAt: 0 })
const response = (body, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: new Headers(headers) })
const searched = (songs = [candidate]) => ({ code: 0, [SEARCH]: { code: 0, data: { body: { song: { list: songs.map((song) => ({
  mid: song.mid, name: song.name, title: song.title, subtitle: song.subtitle, interval: song.duration,
  album: { name: song.album }, singer: song.artists.map((name) => ({ name })),
})) } } } } })
const produced = (data = groups) => ({ code: 0, req_0: { code: 0, data } })

async function setup(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-qq-credits-test-'))
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }))
  const requests = []
  const fetcher = async (url, opts) => {
    const body = JSON.parse(opts.body)
    requests.push({ url, options: opts, body })
    return response(body[SEARCH] ? searched() : produced())
  }
  const settings = { dataDir, intervalMs: 0, coordinator: queue(), fetcher, ...options }
  return { dataDir, requests, settings, provider: new QQCreditsProvider(settings) }
}

test('matching requires title, artist, real album, duration and recording edition; never chooses a first ambiguous hit', () => {
  assert.equal(chooseQQTrack(metadata, [candidate]).status, 'matched')
  for (const changed of [
    { name: '夜航 Live', title: '夜航 Live' }, { artists: ['另一歌手'] }, { album: '精选' },
    { duration: 244 }, { duration: 0 }, { subtitle: 'Live' }, { album: '远行 (Remastered)' },
  ]) assert.equal(chooseQQTrack(metadata, [{ ...candidate, ...changed }]).status, 'uncertain')
  assert.equal(chooseQQTrack(metadata, [candidate, { ...candidate, mid: 'fixtureSong456' }]).status, 'uncertain')
  assert.equal(chooseQQTrack(metadata, [candidate, candidate]).status, 'matched')
  assert.equal(chooseQQTrack({ ...metadata, album: '', duration: 0 }, [candidate]).status, 'uncertain')
  assert.equal(chooseQQTrack({ ...metadata, album: '' }, [candidate]).status, 'matched')
  assert.equal(chooseQQTrack(metadata, []).status, 'not-found')
})

test('matching supports traditional tags, explicit bilingual artist aliases and unordered complete artist sets', () => {
  assert.equal(chooseQQTrack({ ...metadata, album: '遠行', artist: '陳小明 (Chen Xiaoming)' }, [candidate]).status, 'matched')
  const duet = { ...candidate, artists: ['陈小明', '李小红'] }
  assert.equal(chooseQQTrack({ ...metadata, artist: '李小紅 / 陳小明 (Chen Xiaoming)' }, [duet]).status, 'matched')
  assert.equal(chooseQQTrack(metadata, [duet]).status, 'uncertain', 'additional artists cannot be silently ignored')
  assert.equal(chooseQQTrack({ ...metadata, artist: '小明' }, [candidate]).status, 'uncertain', 'no substring artist matching')
  assert.equal(chooseQQTrack({ ...metadata, title: '夜航 (Live)' }, [candidate]).status, 'uncertain', 'version parentheses are not title aliases')
})

test('role mapping preserves every original role and does not treat unknown numeric role IDs as producers', () => {
  assert.deepEqual(readQQCredits(groups), [
    { name: '测试甲', role: '作曲' }, { name: '测试乙', role: '编曲' }, { name: '测试甲', role: '制作人' }, { name: '测试丙', role: '鼓' },
  ])
  assert.equal(readQQCredits({ Lst: [...groups.Lst, groups.Lst[0], { Title: '', Producers: [{ Name: '无角色' }] }] }).length, 4)
  assert.throws(() => readQQCredits({}), /格式/)
  assert.deepEqual(readQQCredits({ Lst: [] }), [])
})

test('lookup uses only public metadata requests, real album tags, track IDs and source URLs; cache survives restart', async (t) => {
  const { provider, requests, dataDir, settings } = await setup(t)
  const progress = []
  const privateAlbum = { ...album, folder: '/private/must-not-leave', tracks: [{ ...track, _path: '/private/music.flac', relativePath: 'private.flac' }] }
  const result = await provider.lookup(privateAlbum, { onProgress: (value) => progress.push(value) })
  assert.equal(result.status, 'matched')
  assert.equal(result.matchedTracks, 1)
  assert.equal(result.totalTracks, 1)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].body[SEARCH].param.query, '夜航 陈小明')
  assert.equal(requests[0].body.comm, undefined)
  assert.equal(requests[1].body.req_0.method, 'SongProducer')
  assert.deepEqual(requests[1].body.req_0.param, { songmid: candidate.mid })
  assert.ok(requests.every(({ url, options }) => url === 'https://u.y.qq.com/cgi-bin/musicu.fcg' && options.method === 'POST' && !JSON.stringify(options).includes('/private/')))
  assert.ok(result.credits.every((credit) => credit.trackId === track.id && credit.source === 'QQ Music' && credit.url === `https://y.qq.com/n/ryqq/songDetail/${candidate.mid}`))
  assert.deepEqual(progress.map((value) => value.completed), [0, 1])
  assert.equal((await provider.lookup(privateAlbum)).status, 'matched')
  assert.equal(requests.length, 2)
  const restored = new QQCreditsProvider({ ...settings, coordinator: queue(), fetcher: async () => { throw new Error('should use disk cache') } })
  assert.equal((await restored.lookup(album)).status, 'matched')
  const cache = await fs.readFile(path.join(dataDir, 'qq-credits-cache.json'), 'utf8')
  assert.ok(!cache.includes('/private/') && !cache.includes('fixture-track'), 'cache contains metadata, not library paths or track identities')
  await provider.lookup(album, { force: true })
  assert.equal(requests.length, 4, 'force deliberately refreshes both successful requests')
})

test('empty and ambiguous search results are cached; expiry permits one fresh query', async (t) => {
  let now = 1_800_000_000_000, calls = 0
  const { provider } = await setup(t, { now: () => now, negativeTtlMs: 1000, fetcher: async () => { calls += 1; return response(searched([])) } })
  assert.equal((await provider.lookup(album)).status, 'not-found')
  assert.equal((await provider.lookup(album)).status, 'not-found')
  assert.equal(calls, 1)
  now += 1001
  await provider.lookup(album)
  assert.equal(calls, 2)
  let ambiguousCalls = 0
  const fixture = await setup(t, { fetcher: async () => { ambiguousCalls += 1; return response(searched([candidate, { ...candidate, mid: 'otherSong123' }])) } })
  assert.equal((await fixture.provider.lookup(album)).status, 'uncertain')
  assert.equal((await fixture.provider.lookup(album)).status, 'uncertain')
  assert.equal(ambiguousCalls, 1)
})

test('missing producer lists are negative cached without inventing credits', async (t) => {
  let calls = 0
  const { provider } = await setup(t, { fetcher: async (_, opts) => { calls += 1; return response(JSON.parse(opts.body)[SEARCH] ? searched() : produced({ Lst: [] })) } })
  assert.equal((await provider.lookup(album)).status, 'not-found')
  assert.equal((await provider.lookup(album)).status, 'not-found')
  assert.equal(calls, 2)
})

test('HTTP 429 stops remaining tracks, persists Retry-After cooldown and force cannot bypass it', async (t) => {
  let now = 1_800_000_000_000, calls = 0
  const { provider, settings } = await setup(t, { now: () => now, fetcher: async () => { calls += 1; return response({}, 429, { 'Retry-After': '120' }) } })
  const collection = { ...album, tracks: [track, { ...track, id: 'second', title: '第二首' }] }
  const first = await provider.lookup(collection)
  assert.equal(first.status, 'error')
  assert.equal(first.retryAt, new Date(now + 120_000).toISOString())
  assert.equal(calls, 1)
  await provider.lookup(collection, { force: true })
  assert.equal(calls, 1)
  const restarted = new QQCreditsProvider({ ...settings, coordinator: queue() })
  await restarted.lookup(collection, { force: true })
  assert.equal(calls, 1, 'restart preserves source cooldown')
  now += 120_001
  await restarted.lookup(collection)
  assert.equal(calls, 2)
})

test('a later 429 preserves earlier verified credits and reports partial without any remaining requests', async (t) => {
  let calls = 0
  const now = Date.parse('2026-10-01T00:00:00Z')
  const { provider } = await setup(t, { now: () => now, fetcher: async (_, opts) => {
    calls += 1
    if (calls === 3) return response({}, 429, { 'Retry-After': 'Thu, 01 Oct 2026 00:02:00 GMT' })
    return response(JSON.parse(opts.body)[SEARCH] ? searched() : produced())
  } })
  const result = await provider.lookup({ ...album, tracks: [track, { ...track, id: 'second', title: '第二首' }, { ...track, id: 'third', title: '第三首' }] })
  assert.equal(result.status, 'partial')
  assert.equal(result.matchedTracks, 1)
  assert.equal(result.credits.length, 4)
  assert.equal(result.retryAt, '2026-10-01T00:02:00.000Z')
  assert.equal(calls, 3)
})

test('HTTP and business failures are errors, never absence; business rate limits also cool down', async (t) => {
  for (const result of [
    response({}, 503), response({ code: 0, [SEARCH]: { code: 2001, data: { body: { song: { list: [] } } } } }),
    response({ code: 429 }), response({ code: 0, [SEARCH]: { code: 9, message: '请求过于频繁' } }),
    response({ code: 0, [SEARCH]: { code: 0, data: {} } }),
  ]) {
    let calls = 0
    const { provider } = await setup(t, { fetcher: async () => { calls += 1; return result } })
    const answer = await provider.lookup({ ...album, tracks: [track, track] })
    assert.equal(answer.status, 'error')
    assert.ok(answer.error && answer.retryAt)
    assert.equal(calls, 1)
  }
})

test('concurrent lookups coalesce identical metadata and serialize search plus personnel with the same pacing', async (t) => {
  let now = 1_800_000_000_000, active = 0, maximum = 0
  const starts = []
  const { provider } = await setup(t, {
    intervalMs: 1500, now: () => now, sleep: async (ms) => { now += ms },
    fetcher: async (_, opts) => {
      active += 1; maximum = Math.max(maximum, active); starts.push(now)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active -= 1
      return response(JSON.parse(opts.body)[SEARCH] ? searched() : produced())
    },
  })
  const results = await Promise.all([provider.lookup(album), provider.lookup({ ...album, tracks: [{ ...track, id: 'another-local-id' }] })])
  assert.equal(maximum, 1)
  assert.equal(starts.length, 2)
  assert.equal(starts[1] - starts[0], 1500)
  assert.ok(results.every((result) => result.status === 'matched'))
  assert.ok(results[1].credits.every((credit) => credit.trackId === 'another-local-id'))
})

test('timeout aborts the request once and no follow-up traffic is attempted', async (t) => {
  let calls = 0
  const { provider } = await setup(t, { timeoutMs: 15, fetcher: async (_, opts) => {
    calls += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(response(searched())), 200)
      opts.signal.addEventListener('abort', () => { clearTimeout(timer); reject(opts.signal.reason) }, { once: true })
    })
  } })
  const result = await provider.lookup({ ...album, tracks: [track, track] })
  assert.equal(result.status, 'error')
  assert.match(result.error, /超时/)
  assert.ok(result.retryAt)
  assert.equal(calls, 1)
})

test('insufficient tags do not issue a query and progress callback failures cannot corrupt lookup', async (t) => {
  const { provider, requests } = await setup(t)
  assert.equal((await provider.lookup({ ...album, tracks: [{ ...track, artist: '未知艺术家' }] })).status, 'uncertain')
  assert.equal(requests.length, 0)
  assert.equal((await provider.lookup(album, { onProgress: () => { throw new Error('UI callback failed') } })).status, 'matched')
})

test('an unreadable cache cannot reject during construction or break local library startup', async (t) => {
  const fixture = await setup(t)
  await fixture.provider.ready
  await fs.mkdir(path.join(fixture.dataDir, 'qq-credits-cache.json'))
  const provider = new QQCreditsProvider({ ...fixture.settings, coordinator: queue() })
  // Waiting a turn models constructing the online provider during local startup.
  await new Promise((resolve) => setTimeout(resolve, 5))
  await assert.doesNotReject(provider.ready)
  const result = await provider.lookup(album)
  assert.equal(result.status, 'error')
  assert.match(result.error, /本地缓存无法读取/)
  assert.equal(fixture.requests.length, 0)
})

test('failed cache writes roll back in-memory success so a recovered lookup persists fresh metadata', async (t) => {
  let now = 1_800_000_000_000
  const { provider, requests, dataDir } = await setup(t, { now: () => now, errorCooldownMs: 1000 })
  await provider.ready
  const cachePath = path.join(dataDir, 'qq-credits-cache.json')
  await fs.mkdir(cachePath)
  const failed = await provider.lookup(album)
  assert.equal(failed.status, 'error')
  assert.match(failed.error, /缓存无法写入/)
  assert.equal(Object.keys(provider.cache.entries).length, 0)
  await fs.rmdir(cachePath)
  now += 1001
  assert.equal((await provider.lookup(album)).status, 'matched')
  assert.equal(requests.length, 3, 'search is fetched again after the failed save')
  assert.equal(Object.keys(JSON.parse(await fs.readFile(cachePath, 'utf8')).entries).length, 2)
})

test('a 429 still exposes retryAt and stops requests even when its cooldown cannot be written', async (t) => {
  let calls = 0
  const { provider, dataDir } = await setup(t, { fetcher: async () => { calls += 1; return response({}, 429, { 'Retry-After': '120' }) } })
  await provider.ready
  await fs.mkdir(path.join(dataDir, 'qq-credits-cache.json'))
  const result = await provider.lookup(album)
  assert.equal(result.status, 'error')
  assert.match(result.error, /429/)
  assert.ok(result.retryAt)
  await provider.lookup(album, { force: true })
  assert.equal(calls, 1)
})
