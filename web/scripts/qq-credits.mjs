import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import OpenCC from 'opencc-js'

// Native, read-only requests to QQ's public metadata service. Request shapes were
// checked against the public service on 2026-10-01; no cookies or signing code.
const ENDPOINT = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const SEARCH = 'music.search.SearchCgiService'
const PRODUCER = 'music.sociality.KolWorksTag'
const DAY = 86_400_000
const sharedQueue = { chain: Promise.resolve(), lastStart: -Infinity, retryAt: 0 }
const clean = (value) => typeof value === 'string' ? value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240) : ''
const simplified = OpenCC.Converter({ from: 'hk', to: 'cn' })
const normalize = (value) => simplified(clean(value)).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
const digest = (value) => createHash('sha256').update(value).digest('hex')
const stamp = (value) => new Date(value).toISOString()
const duration = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function editions(value) {
  const text = clean(value).toLowerCase()
  return [
    ['live', /\blive\b|现场|現場|演唱会|演唱會/],
    ['remix', /\bremix(?:ed)?\b|混音版|重混/],
    ['instrumental', /\binstrumental\b|\bkaraoke\b|伴奏|纯音乐|純音樂/],
    ['acoustic', /\bacoustic\b|\bunplugged\b|不插电|不插電/],
    ['demo', /\bdemo\b|小样|小樣/],
    ['remaster', /\bremaster(?:ed)?\b|重制|重製|重置版/],
    ['rerecord', /re[ -]?record|重新录制|重新錄製/],
    ['edit', /\b(?:radio|single) edit\b|剪辑版|剪輯版/],
    ['cover', /\bcover\b|翻唱/],
  ].filter(([, pattern]) => pattern.test(text)).map(([name]) => name).sort().join(',')
}

function artistAliases(value) {
  const text = clean(value)
  // Explicit bilingual tags only; these aliases are never used for song titles.
  const alias = text.match(/^([\p{Script=Han}·\s]+?)\s*\(([A-Za-z][A-Za-z .'-]+)\)$/u)
    ?? text.match(/^([A-Za-z][A-Za-z .'-]+)\s*\(([\p{Script=Han}·\s]+)\)$/u)
  return new Set([text, ...(alias ? [alias[1], alias[2]] : [])].map(normalize).filter(Boolean))
}

function artistMatches(local, remote) {
  const names = remote.map(artistAliases).filter((names) => names.size)
  if (!names.length) return false
  const overlaps = (a, b) => [...a].some((name) => b.has(name))
  if (names.length === 1 && overlaps(artistAliases(local), names[0])) return true
  const parts = clean(local).split(/\s*(?:[,，、;；/&]|\bfeat\.?|\bfeaturing|\bft\.?)\s*/i).map(artistAliases).filter((names) => names.size)
  if (parts.length !== names.length) return false
  const assign = (index, remaining) => index === parts.length || remaining.some((name, slot) =>
    overlaps(parts[index], name) && assign(index + 1, remaining.filter((_, other) => other !== slot)))
  return assign(0, names)
}

function trackMetadata(track, album) {
  return {
    title: clean(track?.title), artist: clean(track?.artist) || clean(album?.artist),
    // The UI's album title can be a folder name or the title of a loose single.
    // Only a real album tag is evidence for the recording's release.
    album: clean(track?._common?.album), duration: duration(track?.duration),
  }
}

/** Exact metadata evidence, with explicit edition and ambiguity checks. */
export function chooseQQTrack(metadata, candidates) {
  if (!metadata.title || !metadata.artist || /^(?:未知艺术家|未知藝術家|unknown(?: artist)?|various artists)$/i.test(metadata.artist)) {
    return { status: 'uncertain', error: '歌曲名称或歌手不完整，未自动匹配' }
  }
  if (!metadata.album && !metadata.duration) return { status: 'uncertain', error: '缺少真实专辑标签和时长，未自动匹配' }
  const expectedEdition = editions(`${metadata.title} ${metadata.album}`)
  const possible = candidates.filter((song) => {
    if (!/^[A-Za-z0-9]{5,32}$/.test(song.mid ?? '')) return false
    if (![song.name, song.title].some((name) => normalize(name) === normalize(metadata.title))) return false
    if (!artistMatches(metadata.artist, song.artists ?? [])) return false
    if (metadata.album && normalize(song.album) !== normalize(metadata.album)) return false
    if (metadata.duration && (!song.duration || Math.abs(song.duration - metadata.duration) > 3)) return false
    return editions(`${song.name} ${song.title} ${song.subtitle} ${song.album}`) === expectedEdition
  })
  const unique = [...new Map(possible.map((song) => [song.mid, song])).values()]
  if (unique.length === 1) return { status: 'matched', song: unique[0] }
  return { status: candidates.length ? 'uncertain' : 'not-found', ...(unique.length > 1 ? { error: '有多个歌曲版本符合标签，未自动采用制作人员' } : {}) }
}

/** Preserve the service's role labels: an arranger must not become a producer. */
export function readQQCredits(data) {
  if (!Array.isArray(data?.Lst)) throw new Error('QQ Music 制作人员响应格式已变化')
  const seen = new Set()
  const credits = []
  for (const group of data.Lst) {
    const role = clean(group?.Title)
    if (!role || !Array.isArray(group.Producers)) continue
    for (const producer of group.Producers) {
      const name = clean(producer?.Name)
      const key = JSON.stringify([name, role])
      if (!name || seen.has(key)) continue
      seen.add(key)
      credits.push({ name, role })
    }
  }
  return credits
}

function readSongs(data) {
  const list = data?.body?.song?.list
  if (!Array.isArray(list)) throw new Error('QQ Music 搜索响应格式已变化')
  return list.slice(0, 20).map((song) => ({
    mid: clean(song.mid), name: clean(song.name), title: clean(song.title), subtitle: clean(song.subtitle),
    album: clean(song.album?.name ?? song.album?.title),
    artists: (Array.isArray(song.singer) ? song.singer : []).map((singer) => clean(singer.name)).filter(Boolean),
    duration: duration(song.interval),
  }))
}

class SourceError extends Error {
  constructor(message, retryAt) { super(message); this.retryAt = retryAt }
}

function retryDelay(header, now, fallback) {
  if (typeof header === 'string' && header.trim()) {
    const seconds = Number(header)
    const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now
    if (Number.isFinite(parsed) && parsed >= 0) return Math.max(1000, parsed)
  }
  return fallback
}

export class QQCreditsProvider {
  constructor({ dataDir, fetcher = globalThis.fetch, intervalMs = 1500, timeoutMs = 10_000,
    now = Date.now, sleep = delay, positiveTtlMs = 30 * DAY, negativeTtlMs = DAY,
    cooldownMs = 15 * 60_000, errorCooldownMs = 60_000, coordinator } = {}) {
    if (!dataDir) throw new Error('QQCreditsProvider 需要本地 dataDir')
    this.cachePath = path.join(dataDir, 'qq-credits-cache.json')
    this.fetcher = fetcher
    this.intervalMs = Math.max(0, intervalMs)
    this.timeoutMs = timeoutMs
    this.now = now
    this.sleep = sleep
    this.positiveTtlMs = positiveTtlMs
    this.negativeTtlMs = negativeTtlMs
    this.cooldownMs = cooldownMs
    this.errorCooldownMs = errorCooldownMs
    // All default providers share one source queue. Tests can supply an isolated
    // coordinator/clock without changing the production pacing.
    this.queue = coordinator ?? sharedQueue
    this.cache = { version: 1, retryAt: 0, entries: {} }
    this.inFlight = new Map()
    this.saveChain = Promise.resolve()
    // Construction must not create an unhandled rejection while the local
    // library starts. Report cache access problems only when lookup is requested.
    this.ready = this.load().catch((error) => {
      this.loadError = new Error(`QQ Music 本地缓存无法读取（${error.code || '读取失败'}）`)
    })
  }

  async load() {
    try {
      const cache = JSON.parse(await fs.readFile(this.cachePath, 'utf8'))
      if (cache.version === 1 && cache.entries && typeof cache.entries === 'object' && !Array.isArray(cache.entries)) {
        this.cache = cache
        this.queue.retryAt = Math.max(this.queue.retryAt || 0, Number(cache.retryAt) || 0)
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      // A truncated cache is replaceable; it must never turn into false credits.
    }
  }

  async save() {
    this.cache.retryAt = this.queue.retryAt || 0
    const active = Object.entries(this.cache.entries).filter(([, entry]) => entry.expiresAt > this.now()).slice(-5000)
    this.cache.entries = Object.fromEntries(active)
    const snapshot = JSON.stringify(this.cache)
    const task = this.saveChain.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.cachePath), { recursive: true })
      const temporary = `${this.cachePath}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, snapshot, { mode: 0o600 })
        await fs.rename(temporary, this.cachePath)
      } finally { await fs.rm(temporary, { force: true }) }
    })
    this.saveChain = task
    return task
  }

  async suspend(message, milliseconds) {
    const retryAt = this.now() + milliseconds
    this.queue.retryAt = Math.max(this.queue.retryAt || 0, retryAt)
    try { await this.save() }
    catch { message += '；冷却状态未能写入本地缓存' }
    throw new SourceError(message, this.queue.retryAt)
  }

  async request(module, method, param, parse, force) {
    await this.ready
    if (this.loadError) throw this.loadError
    const key = digest(JSON.stringify([module, method, param]))
    const cached = this.cache.entries[key]
    if (!force && cached?.expiresAt > this.now()) return structuredClone(cached.value)
    if (this.inFlight.has(key)) return this.inFlight.get(key)
    const task = this.queue.chain.catch(() => {}).then(async () => {
      if (this.queue.retryAt > this.now()) throw new SourceError('QQ Music 请求处于冷却期，请稍后再试', this.queue.retryAt)
      const wait = this.queue.lastStart + this.intervalMs - this.now()
      if (wait > 0) await this.sleep(wait)
      if (this.queue.retryAt > this.now()) throw new SourceError('QQ Music 请求处于冷却期，请稍后再试', this.queue.retryAt)
      // A preceding request may have populated the same cache while queued.
      const current = this.cache.entries[key]
      if (!force && current?.expiresAt > this.now()) return structuredClone(current.value)
      this.queue.lastStart = this.now()
      const envelopeKey = module === SEARCH ? SEARCH : 'req_0'
      const payload = { ...(module === SEARCH ? {} : { comm: { ct: 24, cv: 0, format: 'json', uin: 0 } }),
        [envelopeKey]: { module, method, param } }
      let response, data
      try {
        response = await this.fetcher(ENDPOINT, {
          method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Referer: 'https://y.qq.com/', 'User-Agent': 'RhineDroid/0.3.1 (public music metadata)' },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error',
        })
      } catch (error) { return this.suspend(`QQ Music 连接失败或超时：${error.name === 'TimeoutError' ? '请求超时' : '无法连接'}`, this.errorCooldownMs) }
      const header = response.headers?.get?.('retry-after')
      if (response.status === 429) return this.suspend('QQ Music 请求过于频繁（HTTP 429），已停止本轮查询', retryDelay(header, this.now(), this.cooldownMs))
      if (!response.ok) return this.suspend(`QQ Music HTTP ${response.status}，已停止本轮查询`, response.status === 403 ? this.cooldownMs : this.errorCooldownMs)
      try { data = await response.json() }
      catch { return this.suspend('QQ Music 返回了无效的 JSON', this.errorCooldownMs) }
      const block = data?.[envelopeKey]
      const codes = [data?.code, block?.code, block?.data?.code].filter((code) => code !== undefined && code !== null)
      const messages = [data?.message, data?.msg, block?.message, block?.msg, block?.data?.message, block?.data?.msg].filter((value) => typeof value === 'string').join(' ')
      const rejected = codes.some((code) => Number(code) !== 0)
      if (codes.some((code) => Number(code) === 429) || /频繁|頻繁|限流|风控|風控|too many|rate.?limit/i.test(messages)) {
        return this.suspend('QQ Music 返回限流提示，已停止本轮查询', retryDelay(header, this.now(), this.cooldownMs))
      }
      if (rejected || !block || !Object.hasOwn(block, 'code')) return this.suspend(`QQ Music 业务请求失败（${codes.join('/') || '未知状态'}）`, this.errorCooldownMs)
      let value
      try { value = parse(block.data) }
      catch (error) { return this.suspend(error.message, this.errorCooldownMs) }
      const fetchedAt = this.now()
      const previous = this.cache.entries[key]
      this.cache.entries[key] = { value, fetchedAt, expiresAt: fetchedAt + (value.length ? this.positiveTtlMs : this.negativeTtlMs) }
      try { await this.save() }
      catch (error) {
        if (previous) this.cache.entries[key] = previous
        else delete this.cache.entries[key]
        this.queue.retryAt = Math.max(this.queue.retryAt || 0, this.now() + this.errorCooldownMs)
        throw new SourceError(`QQ Music 本地缓存无法写入（${error.code || '写入失败'}）`, this.queue.retryAt)
      }
      return structuredClone(value)
    })
    this.queue.chain = task
    this.inFlight.set(key, task)
    try { return await task }
    finally { this.inFlight.delete(key) }
  }

  async lookup(album, { force = false, onProgress = () => {} } = {}) {
    const tracks = Array.isArray(album?.tracks) ? album.tracks : []
    const credits = []
    let matchedTracks = 0, completed = 0, uncertain = false, error, retryAt
    const progress = (trackTitle = '') => { try { onProgress({ completed, total: tracks.length, trackTitle }) } catch { /* UI callbacks do not change source results. */ } }
    progress()
    for (const track of tracks) {
      const metadata = trackMetadata(track, album)
      try {
        const initial = chooseQQTrack(metadata, [])
        if (initial.status === 'uncertain') { uncertain = true; completed += 1; progress(metadata.title); continue }
        const candidates = await this.request(SEARCH, 'DoSearchForQQMusicDesktop', {
          search_type: 0, query: `${metadata.title} ${metadata.artist}`, page_num: 1, num_per_page: 20,
        }, readSongs, force)
        const match = chooseQQTrack(metadata, candidates)
        if (match.status === 'matched') {
          const personnel = await this.request(PRODUCER, 'SongProducer', { songmid: match.song.mid }, readQQCredits, force)
          if (personnel.length) {
            matchedTracks += 1
            credits.push(...personnel.map((person) => ({ ...person, source: 'QQ Music', trackTitle: clean(track.title), trackId: track.id,
              url: `https://y.qq.com/n/ryqq/songDetail/${match.song.mid}` })))
          }
        } else if (match.status === 'uncertain') uncertain = true
        completed += 1
        progress(metadata.title)
      } catch (failure) {
        error = failure.message
        if (failure.retryAt) retryAt = stamp(failure.retryAt)
        progress(metadata.title)
        break // Fail once; no retries, fallback hosts, or remaining album traffic.
      }
    }
    return {
      status: matchedTracks === tracks.length && tracks.length ? 'matched' : matchedTracks ? 'partial' : error ? 'error' : uncertain ? 'uncertain' : 'not-found',
      credits, matchedTracks, totalTracks: tracks.length, checkedAt: stamp(this.now()),
      ...(error ? { error } : {}), ...(retryAt ? { retryAt } : {}),
    }
  }
}
