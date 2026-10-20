import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { AlbumIntroductionProvider, assessCandidate, nameAliases, normalizeName } from './album-introductions.mjs'
import { MusicLibraryStore } from './music-library.mjs'

const album = { id: 'album-test', title: '夜航(Night Flight)', artist: '测试歌手', year: 2001 }
const page = { pageid: 10, title: '夜航', language: 'zh', extract: '《夜航》是測試歌手於2001年發行的錄音室專輯。此文字僅為測試資料。', pageprops: {} }
const response = (data) => ({ ok: true, status: 200, json: async () => data })
const claim = (value) => ({ mainsnak: { datavalue: { value } }, rank: 'normal' })

test('matching handles traditional/simplified and bilingual titles but rejects wrong artist, year and song pages', () => {
  assert.equal(normalizeName('陳奕迅'), normalizeName('陈奕迅'))
  assert.equal(normalizeName('68’29”'), normalizeName('68\'29"'))
  assert.deepEqual(nameAliases('夜航(Night Flight)'), ['夜航(Night Flight)', '夜航', 'Night Flight'])
  assert.equal(assessCandidate(album, page).matched, true)
  assert.equal(assessCandidate({ ...album, artist: '另一歌手' }, page).matched, false)
  assert.equal(assessCandidate({ ...album, year: 2002 }, page).matched, false)
  assert.equal(assessCandidate(album, { ...page, title: '夜航现场版' }).matched, false)
  assert.equal(assessCandidate({ ...album, title: 'Album' }, { ...page, title: 'Unrelated (album)' }).matched, false)
  assert.equal(assessCandidate(album, { ...page, extract: '《夜航》是測試歌手於2001年發行的一首歌曲，收錄在同名專輯中。' }).reason, 'work-type')
  assert.equal(assessCandidate(album, { ...page, pageprops: { disambiguation: '' } }).matched, false)
  const mismatchedRelease = { claims: { P577: [claim({ time: '+2000-01-01T00:00:00Z' })] } }
  assert.equal(assessCandidate(album, page, mismatchedRelease).reason, 'year', 'a matching incidental year cannot override a contradictory structured release date')
})

test('public provider needs no MusicBrainz contact and commits only the formal article extract with attribution', async () => {
  const requests = []
  const provider = new AlbumIntroductionProvider({ intervalMs: 0, fetcher: async (url, options) => {
    requests.push(url)
    assert.match(options.headers['User-Agent'], /RhineDroid/)
    if (url.hostname === 'zh.wikipedia.org') return response({ query: { pages: [{ ...page, pageprops: { wikibase_item: 'Q100' } }] } })
    if (url.searchParams.get('ids') === 'Q100') return response({ entities: { Q100: { labels: { en: { value: 'Night Flight' } }, claims: { P175: [claim({ id: 'Q200' })], P577: [claim({ time: '+2001-03-10T00:00:00Z' })] } } } })
    if (url.searchParams.get('ids') === 'Q200') return response({ entities: { Q200: { labels: { zh: { value: '測試歌手' } } } } })
    throw new Error(`unexpected URL ${url}`)
  } })
  const result = await provider.lookup({ ...album, folder: '/private/do-not-send', localNote: 'not an introduction' })
  assert.equal(result.status, 'matched')
  assert.equal(result.description, page.extract)
  assert.equal(result.descriptionSource.name, '维基百科')
  assert.equal(result.descriptionSource.url, `https://zh.wikipedia.org/wiki/${encodeURIComponent('夜航')}`)
  assert.ok(result.descriptionSource.checkedAt)
  assert.equal(requests.length, 3)
  assert.ok(requests.every((url) => !decodeURIComponent(url.href).includes('/private/do-not-send')))
  assert.ok(requests.every((url) => !decodeURIComponent(url.href).includes('2001')), 'the release year is checked locally, not transmitted')
})

test('all sources failing yields error, never a cached not-found or fabricated success', async () => {
  let calls = 0
  const provider = new AlbumIntroductionProvider({ intervalMs: 0, fetcher: async () => { calls += 1; throw new Error('fixture connection timeout') } })
  const result = await provider.lookup(album)
  assert.equal(result.status, 'error')
  assert.match(result.error, /连接失败或超时/)
  assert.equal(result.description, undefined)
  assert.equal(calls, 2)
  const throttled = new AlbumIntroductionProvider({ intervalMs: 0, fetcher: async () => ({ ok: false, status: 429 }) })
  assert.equal((await throttled.lookup(album)).status, 'error')
})

test('two plausible articles remain uncertain, and a title with an empty extract is not reported absent', async () => {
  const provider = new AlbumIntroductionProvider({ intervalMs: 0, fetcher: async (url) => response({ query: { pages: url.hostname === 'zh.wikipedia.org' ? [page, { ...page, pageid: 11, title: 'Night Flight (album)' }] : [] } }) })
  const result = await provider.lookup(album)
  assert.equal(result.status, 'uncertain')
  assert.equal(result.description, undefined)
  const empty = new AlbumIntroductionProvider({ intervalMs: 0, fetcher: async () => response({ query: { pages: [{ ...page, extract: '' }] } }) })
  const noExtract = await empty.lookup(album)
  assert.equal(noExtract.status, 'uncertain')
  assert.match(noExtract.error, /没有可读取的导言/)
})

test('Wikipedia search discovers a candidate but its snippet is never used as the introduction', async () => {
  const provider = new AlbumIntroductionProvider({ intervalMs: 0, fetcher: async (url) => {
    const searched = url.searchParams.get('generator') === 'search'
    return response({ query: { pages: searched ? [{ ...page, snippet: 'FAKE SEARCH SNIPPET MUST NOT BECOME INTRODUCTION' }] : [] } })
  } })
  const result = await provider.lookup(album)
  assert.equal(result.status, 'matched')
  assert.equal(result.description, page.extract)
  assert.ok(!result.description.includes('SNIPPET'))
})

async function storeFixture(t, introductionProvider, count = 1) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-introduction-test-'))
  t.after(() => fs.rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'music')
  await fs.mkdir(root)
  for (let i = 0; i < count; i += 1) {
    const folder = path.join(root, `Album ${i}`)
    await fs.mkdir(folder)
    await fs.writeFile(path.join(folder, '01.flac'), 'synthetic fixture, not real music')
  }
  const store = await new MusicLibraryStore({ dataDir: path.join(temporary, 'index'), defaultRoots: [root], introductionProvider, metadataParser: async () => ({ common: { album: album.title, artist: album.artist, year: album.year, comment: [{ text: 'local note is not an album introduction' }] }, format: {} }) }).init()
  await store.scan()
  return store
}

test('store caches successful introductions across restarts, preserves existing text on failure, and coalesces requests', async (t) => {
  let resolve
  let calls = 0
  const gate = new Promise((done) => { resolve = done })
  const store = await storeFixture(t, { lookup: async () => {
    calls += 1
    await gate
    return { status: 'matched', checkedAt: new Date().toISOString(), description: page.extract, descriptionSource: { name: '维基百科', url: 'https://zh.wikipedia.org/wiki/Test_fixture' } }
  } })
  const first = store.updateIntroductions()
  const second = store.updateIntroductions({ force: true })
  resolve()
  await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.equal(store.snapshot().introductions.updated, 1)
  assert.equal(store.snapshot().albums[0].description, page.extract)
  assert.notEqual(store.snapshot().albums[0].description, store.snapshot().albums[0].localNote)
  await store.updateIntroductions()
  assert.equal(calls, 1, 'existing attributed descriptions are not re-requested without force')
  assert.equal(store.introductionsPromise, null)
  const reloaded = await new MusicLibraryStore({ dataDir: store.dataDir, introductionProvider: { lookup: async () => ({ status: 'error', error: 'fixture connection unavailable' }) } }).init()
  assert.equal(reloaded.snapshot().albums[0].description, page.extract)
  await reloaded.updateIntroductions({ force: true })
  assert.equal(reloaded.snapshot().introductions.failed, 1)
  assert.equal(reloaded.snapshot().introductions.updated, 0)
  assert.equal(reloaded.snapshot().albums[0].description, page.extract)
  assert.equal(reloaded.snapshot().albums[0].introduction.status, 'error')
})

test('batch stops after three consecutive source failures and leaves remaining albums for retry', async (t) => {
  let calls = 0
  const store = await storeFixture(t, { lookup: async () => { calls += 1; return { status: 'error', error: 'fixture network timeout' } } }, 6)
  await store.updateIntroductions()
  const result = store.snapshot()
  assert.equal(calls, 3)
  assert.equal(result.introductions.total, 6)
  assert.equal(result.introductions.completed, 3)
  assert.equal(result.introductions.failed, 3)
  assert.equal(result.introductions.updated, 0)
  assert.equal(result.introductions.running, false)
  assert.match(result.introductions.error, /剩余 3 张/)
  assert.equal(result.albums.filter((entry) => !entry.introduction).length, 3)
})

test('a simultaneous scan retains a newly returned introduction and manual genres', async (t) => {
  const store = await storeFixture(t, { lookup: async () => ({ status: 'matched', checkedAt: new Date().toISOString(), description: page.extract, descriptionSource: { name: '维基百科', url: 'https://zh.wikipedia.org/wiki/Test_fixture' } }) })
  const id = store.snapshot().albums[0].id
  await store.updateRules({ ...store.rules, albumOverrides: { [id]: 'jazz' } })
  await Promise.all([store.scan(), store.updateIntroductions()])
  assert.equal(store.snapshot().albums[0].description, page.extract)
  assert.equal(store.snapshot().albums[0].genreId, 'jazz')
  const reloaded = await new MusicLibraryStore({ dataDir: store.dataDir }).init()
  assert.equal(reloaded.snapshot().albums[0].description, page.extract)
})
