import OpenCC from 'opencc-js'

const simplified = OpenCC.Converter({ from: 'hk', to: 'cn' })
const traditional = OpenCC.Converter({ from: 'cn', to: 'tw' })
const unique = (values) => [...new Set(values.filter(Boolean))]
const clean = (value) => typeof value === 'string' ? value.trim().normalize('NFKC').replace(/[‘’′]/g, "'").replace(/[“”]/g, '"') : ''
const now = () => new Date().toISOString()
const values = (object) => Object.values(object ?? {})

export const normalizeName = (value) => simplified(clean(value)).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')

/** Parenthetical translations are alternative titles, not fuzzy substrings. */
export function nameAliases(value) {
  const name = clean(value)
  const bracketed = [...name.matchAll(/[（(]([^()（）]+)[)）]/g)].map((match) => clean(match[1])).filter((part) => !/^(?:(?:19|20)\d{2}\s*)?(?:album|EP|single|compilation|專輯|专辑|唱片|單曲|单曲)$/i.test(part))
  const outside = name.replace(/[（(][^()（）]+[)）]/g, '').trim()
  const aliases = [name, outside, ...bracketed].flatMap((part) => [part, part.replace(/\s*-\s*(?:EP|Single)$/i, '').trim()])
  return unique(aliases.filter((part) => normalizeName(part).length > 1))
}

function artistAliases(album) {
  const candidates = nameAliases(album.artist)
  // Common bilingual tags contain one Han name followed by its Latin spelling.
  for (const candidate of [...candidates]) {
    const bilingual = /^([\p{Script=Han}·\s]+?)\s+([A-Za-z][A-Za-z\s.'-]+)$/u.exec(candidate)
    if (bilingual) candidates.push(bilingual[1].trim(), bilingual[2].trim())
  }
  return unique(candidates.filter((value) => !/未知|unknown|various artists/i.test(value)))
}

function albumAliases(album) {
  const artists = artistAliases(album).map(normalizeName)
  const aliases = nameAliases(album.title)
  for (const name of [...aliases]) for (const artist of artists) {
    const title = normalizeName(name)
    if (title.startsWith(artist) && title.length - artist.length >= 3) aliases.push(title.slice(artist.length))
  }
  return unique(aliases)
}

function pageNames(page, entity) {
  const base = clean(page.title).replace(/\s*\((?:[^()]*\s)?(?:album|EP|compilation|專輯|专辑|唱片|精選輯|精选辑)\)\s*$/i, '')
  return unique([page.title, base, ...values(entity?.labels).map((label) => label.value), ...values(entity?.aliases).flatMap((aliases) => aliases.map((alias) => alias.value))].flatMap(nameAliases))
}

const claimValues = (entity, property) => (entity?.claims?.[property] ?? []).filter((claim) => claim.rank !== 'deprecated').map((claim) => claim.mainsnak?.datavalue?.value).filter(Boolean)
const entityNames = (entity) => unique([...values(entity?.labels).map((label) => label.value), ...values(entity?.aliases).flatMap((aliases) => aliases.map((alias) => alias.value))].map(normalizeName))

/** Return a reason rather than weakening an ambiguous title or release-year match. */
export function assessCandidate(album, page, entity, performers = {}) {
  if (page.missing || Object.hasOwn(page.pageprops ?? {}, 'disambiguation')) return { matched: false, reason: 'disambiguation' }
  const titles = new Set(albumAliases(album).map(normalizeName))
  if (!pageNames(page, entity).some((title) => titles.has(normalizeName(title)))) return { matched: false, reason: 'title' }
  const artists = artistAliases(album).map(normalizeName)
  if (!artists.length) return { matched: false, reason: 'missing-artist' }
  const performerIds = claimValues(entity, 'P175').map((value) => value.id).filter(Boolean)
  const years = claimValues(entity, 'P577').map((value) => Number(value.time?.match(/^\+(\d{4})-/)?.[1])).filter(Number.isFinite)
  const year = Number(album.year)
  const intro = clean(page.extract).split(/\n\s*\n/)[0]
  const firstSentence = intro.split(/[。\n]/)[0]
  const describesAlbum = /专辑|專輯|唱片|精选辑|精選輯|合辑|合輯|\balbum\b|\bEP\b|\bcompilation\b/i.test(firstSentence)
  const describesSong = /(?:是|為|为)[^。]{0,60}(?:一首|歌曲)|\bis (?:an? |the )?[^.]{0,35}\bsong\b/i.test(firstSentence)
  if (!describesAlbum || describesSong) return { matched: false, reason: 'work-type' }
  // A known structured contradiction must never be rescued by an incidental
  // mention in the article introduction.
  if (performerIds.length && !performerIds.some((id) => entityNames(performers[id]).some((name) => artists.includes(name)))) return { matched: false, reason: 'artist' }
  if (year && years.length && !years.includes(year)) return { matched: false, reason: 'year' }
  if (performerIds.length && year && years.includes(year)) return { matched: true, evidence: 'Wikidata performer and publication date' }
  const normalizedIntro = normalizeName(intro)
  const mentionsArtist = artists.some((artist) => normalizedIntro.includes(artist))
  const yearPublication = year && new RegExp(`(?:${year}[^。.!?\\n]{0,90}(?:发[行佈布]|發[行佈布]|推出|出版|released|published)|(?:发行|發行|推出|出版|released|published)[^。.!?\\n]{0,90}${year})`, 'i').test(intro)
  if (mentionsArtist && describesAlbum && yearPublication) return { matched: true, evidence: 'Wikipedia album introduction: title, performer and release year' }
  return { matched: false, reason: year ? 'insufficient-evidence' : 'missing-year' }
}

export class AlbumIntroductionProvider {
  constructor({ fetcher = globalThis.fetch, intervalMs = 1100, timeoutMs = 8000, contact } = {}) {
    this.fetcher = fetcher
    this.intervalMs = intervalMs
    this.timeoutMs = timeoutMs
    this.contact = contact
    this.lastRequest = 0
    this.requestChain = Promise.resolve()
    this.entities = new Map()
  }

  request(url) {
    const task = this.requestChain.catch(() => {}).then(async () => {
      const allowed = ['zh.wikipedia.org', 'en.wikipedia.org', 'www.wikidata.org']
      if (url.protocol !== 'https:' || !allowed.includes(url.hostname)) throw new Error('不支持的专辑介绍来源')
      const delay = this.lastRequest + this.intervalMs - Date.now()
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      this.lastRequest = Date.now()
      const contact = typeof this.contact === 'function' ? this.contact() : this.contact
      const headers = { Accept: 'application/json', 'User-Agent': `RhineDroid/0.2 (personal music library metadata client${contact ? `; ${contact}` : ''})` }
      let response
      try { response = await this.fetcher(url, { headers, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' }) }
      catch (error) { throw new Error(`${url.hostname} 连接失败或超时：${error.message}`) }
      if (!response.ok) throw new Error(`${url.hostname} HTTP ${response.status}`)
      const data = await response.json()
      if (data.error) throw new Error(`${url.hostname}: ${data.error.info ?? data.error.code ?? 'API error'}`)
      return data
    })
    this.requestChain = task
    return task
  }

  async wikidata(ids) {
    const missing = unique(ids).filter((id) => /^Q\d+$/.test(id) && !this.entities.has(id))
    if (missing.length) {
      const url = new URL('https://www.wikidata.org/w/api.php')
      url.search = new URLSearchParams({ action: 'wbgetentities', format: 'json', ids: missing.slice(0, 30).join('|'), props: 'labels|aliases|claims|sitelinks', languages: 'zh|zh-hans|zh-hant|zh-cn|zh-tw|en', languagefallback: '1' }).toString()
      const result = await this.request(url)
      for (const id of missing) this.entities.set(id, result.entities?.[id] ?? null)
    }
    return Object.fromEntries(unique(ids).map((id) => [id, this.entities.get(id)]))
  }

  async pages(language, params) {
    const url = new URL(`https://${language}.wikipedia.org/w/api.php`)
    url.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', prop: 'extracts|pageprops|info', exintro: '1', explaintext: '1', exchars: '1000', inprop: 'url', redirects: '1', converttitles: '1', ...params }).toString()
    const data = await this.request(url)
    return (data.query?.pages ?? []).filter((page) => page.pageid > 0 && !page.missing).map((page) => ({ ...page, language }))
  }

  async candidates(album, pages) {
    const existing = pages.filter((page) => !Object.hasOwn(page.pageprops ?? {}, 'disambiguation'))
    const possible = existing.filter((page) => clean(page.extract))
    const ids = possible.map((page) => page.pageprops?.wikibase_item).filter((id) => /^Q\d+$/.test(id ?? ''))
    let entities = {}, performers = {}
    let structuredError
    if (ids.length) {
      try {
        entities = await this.wikidata(ids)
        const performerIds = values(entities).flatMap((entity) => claimValues(entity, 'P175').map((value) => value.id))
        if (performerIds.length) performers = await this.wikidata(performerIds)
      } catch (error) { structuredError = error.message }
    }
    const assessed = possible.map((page) => {
      const entity = entities[page.pageprops?.wikibase_item]
      return { page, ...assessCandidate(album, page, entity, performers) }
    })
    const matched = unique(assessed.filter((item) => item.matched).map((item) => item.page.pageprops?.wikibase_item ?? `${item.page.language}:${item.page.pageid}`))
    if (matched.length > 1) return { status: 'uncertain', error: '存在多个名称、歌手和年份均符合的百科条目，未自动采用' }
    if (matched.length === 1) {
      const result = assessed.find((item) => item.matched)
      const page = result.page
      return {
        status: 'matched', description: clean(page.extract),
        descriptionSource: { name: page.language === 'zh' ? '维基百科' : 'Wikipedia', url: `https://${page.language}.wikipedia.org/wiki/${encodeURIComponent(page.title.replaceAll(' ', '_'))}`, checkedAt: now(), license: 'CC BY-SA（以来源页为准）' },
      }
    }
    if (structuredError) return { status: 'error', error: structuredError }
    return { status: existing.length ? 'uncertain' : 'not-found', ...(existing.length && !possible.length ? { error: '百科条目存在，但没有可读取的导言' } : {}), candidateUrl: possible[0] ? `https://${possible[0].language}.wikipedia.org/wiki/${encodeURIComponent(possible[0].title.replaceAll(' ', '_'))}` : undefined }
  }

  async lookup(album) {
    if (!clean(album.title) || !artistAliases(album).length || !album.year) return { status: 'uncertain', checkedAt: now(), error: '本地专辑名称、歌手或年份不完整，无法可靠匹配' }
    const aliases = albumAliases(album)
    const titles = unique(aliases.flatMap((title) => [title, simplified(title), traditional(title)])).slice(0, 12)
    const failures = []
    let uncertain
    let sourceSucceeded = false
    for (const language of ['zh', 'en']) {
      try {
        const direct = await this.pages(language, { titles: titles.join('|') })
        let result = await this.candidates(album, direct)
        if (result.status === 'matched') return { ...result, checkedAt: now() }
        if (result.status === 'error') failures.push(result.error)
        if (result.status === 'uncertain') uncertain = result
        // Discovery only. Search snippets are deliberately neither requested nor saved.
        const title = aliases.find((alias) => language === 'zh' ? /\p{Script=Han}/u.test(alias) : /^[\x00-\x7F]+$/.test(alias)) ?? aliases[0]
        const artist = artistAliases(album).find((alias) => language === 'zh' ? /\p{Script=Han}/u.test(alias) : /^[\x00-\x7F]+$/.test(alias)) ?? album.artist
        const searched = await this.pages(language, { generator: 'search', gsrsearch: `"${title.replaceAll('"', ' ')}" "${artist.replaceAll('"', ' ')}"`, gsrlimit: '5', gsrnamespace: '0' })
        const merged = [...new Map([...direct, ...searched].map((page) => [page.pageid, page])).values()]
        result = await this.candidates(album, merged)
        if (result.status === 'matched') return { ...result, checkedAt: now() }
        if (result.status === 'error') failures.push(result.error)
        else sourceSucceeded = true
        if (result.status === 'uncertain') uncertain = result
      } catch (error) { failures.push(error.message) }
    }
    if (!sourceSucceeded && failures.length) return { status: 'error', checkedAt: now(), error: unique(failures).join('；') }
    return { ...(uncertain ?? { status: 'not-found' }), checkedAt: now(), ...(failures.length ? { error: `部分来源无法访问：${unique(failures).join('；')}` } : {}) }
  }
}
