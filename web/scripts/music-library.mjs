import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import { AlbumIntroductionProvider } from './album-introductions.mjs'
import { QQCreditsProvider } from './qq-credits.mjs'
import { readLocalCredits } from './local-music-credits.mjs'

const AUDIO_EXTENSIONS = new Set(['.ape', '.wv', '.wma', '.flac', '.wav', '.m4a', '.mp4', '.alac', '.dsf', '.dff', '.mp3', '.aac', '.aiff', '.aif', '.ogg', '.opus'])
const BROWSER_EXTENSIONS = new Set(['.flac', '.wav', '.m4a', '.mp4', '.mp3', '.aac', '.ogg', '.opus'])
const MBID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const unique = (items) => [...new Set(items.filter(Boolean))]
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24)
const text = (value) => typeof value === 'string' ? value.trim() : ''
const normalized = (value) => text(value).normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
const exists = async (file) => { try { await fs.access(file); return true } catch { return false } }
const timestamp = () => new Date().toISOString()
const METADATA_VERSION = 4
// v4 adds indexable extensions and derives PCM routes in snapshot(); tag extraction
// is unchanged from v3. Reuse those parsed fields without rereading every source.
// Older schemas still need the metadata/credits migration introduced in v3.
const COMPATIBLE_METADATA_VERSIONS = new Set([3, METADATA_VERSION])
const creditsIdentity = (album) => hash(JSON.stringify(album.tracks.map((track) => [track.id, track.title, track.artist, track.duration, track._common?.album, track._fingerprint])))

export const DEFAULT_RULES = {
  version: 1,
  genres: [
    { id: 'mandopop', name: '华语流行', aliases: ['Mandopop', '国语流行音乐', '华语流行音乐', '华语流行', '国语流行', 'Chinese Pop'] },
    { id: 'pop', name: '流行', aliases: ['Pop', '流行音乐'] },
    { id: 'rock', name: '摇滚', aliases: ['Rock', '摇滚音乐'] },
    { id: 'jazz', name: '爵士', aliases: ['Jazz', '爵士乐'] },
    { id: 'classical', name: '古典', aliases: ['Classical', '古典音乐'] },
    { id: 'electronic', name: '电子', aliases: ['Electronic', 'Electronica', '电子音乐'] },
    { id: 'ambient', name: '氛围', aliases: ['Ambient', '氛围音乐'] },
    { id: 'soundtrack', name: '原声', aliases: ['Soundtrack', 'OST', '原声音乐', '电影原声'] },
    { id: 'unclassified', name: '未分类', aliases: [] },
  ],
  albumOverrides: {},
}

export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw new Error(`无法读取 ${file}: ${error.message}`) }
}

export function validateRules(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.genres) || value.genres.length > 1000 || !value.albumOverrides || typeof value.albumOverrides !== 'object' || Array.isArray(value.albumOverrides)) throw new Error('流派规则需要 version:1、genres 数组和 albumOverrides 对象')
  const ids = new Set()
  const genres = value.genres.map((genre) => {
    if (!genre || typeof genre.id !== 'string' || !/^[\w-]{1,100}$/.test(genre.id) || ids.has(genre.id) || !text(genre.name) || (genre.aliases !== undefined && (!Array.isArray(genre.aliases) || genre.aliases.some((alias) => typeof alias !== 'string')))) throw new Error('流派 ID 必须唯一，名称和别名必须为文本')
    ids.add(genre.id)
    return { id: genre.id, name: text(genre.name), aliases: unique((genre.aliases ?? []).map(text)) }
  })
  if (!ids.has('unclassified')) genres.push({ id: 'unclassified', name: '未分类', aliases: [] })
  ids.add('unclassified')
  const albumOverrides = {}
  for (const [id, genreId] of Object.entries(value.albumOverrides)) {
    if (!ids.has(genreId)) throw new Error(`专辑 ${id} 的人工流派 ${genreId} 不存在`)
    Object.defineProperty(albumOverrides, id, { value: genreId, enumerable: true, writable: true, configurable: true })
  }
  return { version: 1, genres, albumOverrides }
}

export function resolveGenre(album, rules) {
  const override = Object.hasOwn(rules.albumOverrides, album.id) ? rules.albumOverrides[album.id] : undefined
  if (override && rules.genres.some((genre) => genre.id === override)) return override
  const inputs = unique([...(album._onlineGenres ?? []), ...(album._localGenres ?? album.rawGenres ?? [])])
  for (const input of inputs) {
    const target = normalized(input)
    const match = rules.genres.find((genre) => [genre.name, genre.id, ...(genre.aliases ?? [])].some((alias) => normalized(alias) === target))
    if (match) return match.id
  }
  return inputs.length ? `source-${hash(normalized(inputs[0]))}` : 'unclassified'
}

export function safeRootList(roots) {
  if (!Array.isArray(roots) || roots.length > 64 || roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0'))) throw new Error('音乐目录必须是绝对路径数组（最多 64 个）')
  // Nested roots would scan the same album twice; keep the highest selected root.
  return unique(roots.map((root) => path.resolve(root))).filter((root, _, all) => !all.some((parent) => parent !== root && root.startsWith(`${parent}${path.sep}`)))
}

function audioMime(file) {
  return ({ '.flac': 'audio/flac', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aiff': 'audio/aiff', '.aif': 'audio/aiff' })[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

export function imageMime(file) {
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' })[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/** Root-level files are singles; nested folders are albums. Source files stay read-only. */
async function walkAlbums(root) {
  const folders = []
  const visit = async (folder) => {
    const entries = await fs.readdir(folder, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
    const files = entries.filter((entry) => entry.isFile())
    const tracks = files.filter((entry) => AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())).map((entry) => path.join(folder, entry.name))
    if (tracks.length) {
      const images = files.filter((entry) => /\.(png|jpe?g|webp)$/i.test(entry.name))
      const preferred = ['cover', 'folder', 'front']
      images.sort((a, b) => {
        const rank = (entry) => { const value = preferred.indexOf(path.parse(entry.name).name.toLowerCase()); return value < 0 ? 99 : value }
        return rank(a) - rank(b) || a.name.localeCompare(b.name)
      })
      if (folder === root) {
        for (const file of tracks) {
          const name = path.parse(file).name.normalize('NFC').toLocaleLowerCase()
          const image = images.find((entry) => path.parse(entry.name).name.normalize('NFC').toLocaleLowerCase() === name)
          folders.push({ folder, tracks: [file], singleFile: file, cover: image ? path.join(folder, image.name) : undefined })
        }
      } else {
        folders.push({ folder, tracks, cover: images[0] ? path.join(folder, images[0].name) : undefined })
      }
    }
    for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.')) await visit(path.join(folder, entry.name))
  }
  await visit(root)
  return folders
}

const albumEntryId = (entry) => `album-${hash(entry.singleFile ?? entry.folder)}`
const firstString = (value) => Array.isArray(value) ? text(value[0]) : text(value)
const numberOrUndefined = (value) => Number.isFinite(value) && value > 0 ? value : undefined

export class MusicLibraryStore {
  constructor({ dataDir, defaultRoots = [], metadataParser = parseFile, fetcher = globalThis.fetch, musicBrainzContact = process.env.MUSICBRAINZ_CONTACT, introductionProvider, creditsProvider, onChange = () => {} }) {
    this.dataDir = path.resolve(dataDir)
    this.defaultRoots = defaultRoots
    this.parseFile = metadataParser
    this.fetcher = fetcher
    this.musicBrainzContact = musicBrainzContact
    this.environmentContact = musicBrainzContact
    this.onChange = onChange
    this.config = { version: 1, roots: [], onlineEnabled: false, foobarBaseUrl: null }
    this.index = { version: 1, albums: [], roots: [], scannedAt: null }
    this.rules = structuredClone(DEFAULT_RULES)
    this.scanStatus = { running: false }
    this.enrichStatus = { running: false, completed: 0, total: 0 }
    this.introductionsStatus = { running: false, completed: 0, total: 0, updated: 0, notFound: 0, failed: 0 }
    this.introductionProvider = introductionProvider ?? new AlbumIntroductionProvider({ fetcher, contact: () => this.musicBrainzContact })
    this.creditsProvider = creditsProvider ?? new QQCreditsProvider({ dataDir: this.dataDir, fetcher })
    this.creditsStatus = { running: false, completed: 0, total: 0, updated: 0, notFound: 0, failed: 0 }
    this.lastMusicBrainzRequest = 0
    this.saveChain = Promise.resolve()
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true })
    this.config = await readJson(path.join(this.dataDir, 'config.json'), { ...this.config, roots: safeRootList(this.defaultRoots) })
    this.musicBrainzContact = this.config.musicBrainzContact || this.environmentContact
    this.config.roots = safeRootList(this.config.roots)
    this.index = await readJson(path.join(this.dataDir, 'library-index.json'), this.index)
    if (this.index.version !== 1 || !Array.isArray(this.index.albums)) throw new Error('曲库索引版本或格式不受支持，已保留原文件')
    this.rules = validateRules(await readJson(path.join(this.dataDir, 'genre-rules.json'), DEFAULT_RULES))
    if (!(await exists(path.join(this.dataDir, 'genre-rules.json')))) await writeJsonAtomic(path.join(this.dataDir, 'genre-rules.json'), this.rules)
    await writeJsonAtomic(path.join(this.dataDir, 'config.json'), this.config)
    return this
  }

  saveIndex() {
    // Serialize snapshots so an enrichment finishing during a scan cannot leave
    // an older snapshot on disk after a newer one has been written.
    const snapshot = structuredClone(this.index)
    this.saveChain = this.saveChain.catch(() => {}).then(() => writeJsonAtomic(path.join(this.dataDir, 'library-index.json'), snapshot))
    return this.saveChain
  }

  async reloadRules() {
    this.rules = validateRules(await readJson(path.join(this.dataDir, 'genre-rules.json'), DEFAULT_RULES))
  }

  async updateRules(value) {
    const rules = validateRules(value)
    const file = path.join(this.dataDir, 'genre-rules.json')
    if (await exists(file)) await fs.copyFile(file, `${file}.backup`)
    await writeJsonAtomic(file, rules)
    this.rules = rules
    this.onChange()
    return rules
  }

  async updateConfig(value) {
    const next = { ...this.config }
    if (value.roots !== undefined) next.roots = safeRootList(value.roots)
    if (value.onlineEnabled !== undefined) {
      if (typeof value.onlineEnabled !== 'boolean') throw new Error('onlineEnabled 必须为布尔值')
      next.onlineEnabled = value.onlineEnabled
    }
    if (value.musicBrainzContact !== undefined) {
      if (typeof value.musicBrainzContact !== 'string' || value.musicBrainzContact.length > 500 || /[\r\n]/.test(value.musicBrainzContact)) throw new Error('MusicBrainz 联系方式必须是邮箱或项目网址')
      const contact = value.musicBrainzContact.trim()
      if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) && !/^https?:\/\/\S+$/.test(contact)) throw new Error('请输入有效的联系邮箱或 http(s) 项目网址')
      next.musicBrainzContact = contact
    }
    if (value.foobarBaseUrl !== undefined) {
      if (!value.foobarBaseUrl) next.foobarBaseUrl = null
      else {
        const url = new URL(value.foobarBaseUrl)
        if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('foobar 仅允许本机 HTTP 地址，例如 http://127.0.0.1:8880')
        next.foobarBaseUrl = url.origin
      }
    }
    await writeJsonAtomic(path.join(this.dataDir, 'config.json'), next)
    this.config = next
    this.musicBrainzContact = next.musicBrainzContact || this.environmentContact
    return next
  }

  snapshot() {
    const counts = new Map()
    const generated = new Map()
    const albums = this.index.albums.filter((album) => this.config.roots.includes(album._root)).map((album) => {
      const genreId = resolveGenre(album, this.rules)
      counts.set(genreId, (counts.get(genreId) ?? 0) + 1)
      if (genreId.startsWith('source-')) generated.set(genreId, { id: genreId, name: album._onlineGenres?.[0] ?? album._localGenres?.[0] ?? album.rawGenres[0] })
      return {
        id: album.id, title: album.title, artist: album.artist, year: album.year, discCount: album.discCount,
        description: album.descriptionSource?.url ? album.description : undefined, descriptionSource: album.descriptionSource?.url ? album.descriptionSource : undefined,
        localNote: album.localNote,
        introduction: album.introduction,
        genreId, rawGenres: unique([...(album._onlineGenres ?? []), ...(album._localGenres ?? [])]),
        folder: album.folder, coverUrl: album._cover ? `/api/artwork/${album.id}?v=${album._cover.version}` : undefined,
        tracks: album.tracks.map(({ _path, _fingerprint, _common, _embeddedCover, _metadataVersion, ...track }) => ({ ...track, decodedAudioUrl: `/api/decoded-audio/${track.id}`, localDecodable: true })),
        producers: album.producers ?? [], offline: !!album.offline,
        creditsLookup: album.creditsLookup,
        online: album.online ?? { status: 'unqueried' },
      }
    })
    const genres = [...this.rules.genres, ...generated.values()].filter((genre) => counts.has(genre.id)).map((genre) => ({ ...genre, albumCount: counts.get(genre.id) ?? 0 }))
    return {
      version: 1, albums, genres,
      roots: this.config.roots.map((root) => this.index.roots.find((entry) => entry.path === root) ?? { path: root, status: 'unscanned' }),
      scan: { ...this.scanStatus }, onlineEnabled: !!this.config.onlineEnabled, enrich: { ...this.enrichStatus },
      introductions: { ...this.introductionsStatus },
      credits: { ...this.creditsStatus },
    }
  }

  async scan({ roots } = {}) {
    if (this.scanPromise) return this.scanPromise
    this.scanStatus = { running: true, startedAt: timestamp() }
    this.scanPromise = (async () => {
      try {
        if (roots !== undefined) await this.updateConfig({ roots })
        await this.reloadRules()
        const nextAlbums = []
        const nextRoots = []
        for (const root of this.config.roots) {
          const previous = this.index.albums.filter((album) => album._root === root)
          try {
            const stat = await fs.stat(root)
            if (!stat.isDirectory()) throw new Error('根目录不是文件夹')
            // Finish enumeration before replacing anything: partial permission
            // failures must never masquerade as deletions.
            const folders = await walkAlbums(root)
            const rootAlbums = []
            const previousById = new Map(previous.map((album) => [album.id, album]))
            for (const folder of folders) rootAlbums.push(await this.readAlbum(root, folder, previousById.get(albumEntryId(folder))))
            nextAlbums.push(...rootAlbums)
            nextRoots.push({ path: root, status: 'online' })
          } catch (error) {
            nextRoots.push({ path: root, status: 'offline', error: error.message })
            nextAlbums.push(...previous.map((album) => ({ ...album, offline: true })))
          }
        }
        // A concurrent online request may have updated the prior objects.
        for (const album of nextAlbums) {
          const current = this.index.albums.find((entry) => entry.id === album.id)
          if (current?.online?.checkedAt && (!album.online?.checkedAt || current.online.checkedAt > album.online.checkedAt)) {
            album.online = current.online
            album._onlineGenres = current._onlineGenres
            album.description = current.description
            album.descriptionSource = current.descriptionSource
            album.producers = uniqueProducers([...(album.producers ?? []).filter((person) => person.source !== 'MusicBrainz'), ...current.producers.filter((person) => person.source === 'MusicBrainz')])
          }
          if (current?.introduction?.checkedAt && current.title === album.title && current.artist === album.artist && current.year === album.year && (!album.introduction?.checkedAt || current.introduction.checkedAt > album.introduction.checkedAt)) {
            album.introduction = current.introduction
            album.description = current.description
            album.descriptionSource = current.descriptionSource
          }
          if (current?.creditsLookup?.checkedAt && creditsIdentity(current) === creditsIdentity(album) && (!album.creditsLookup?.checkedAt || current.creditsLookup.checkedAt >= album.creditsLookup.checkedAt)) {
            album.creditsLookup = current.creditsLookup
            album.producers = uniqueProducers([...(album.producers ?? []).filter((person) => person.source !== 'QQ Music'), ...(current.producers ?? []).filter((person) => person.source === 'QQ Music')])
          }
        }
        this.index = { version: 1, albums: nextAlbums, roots: nextRoots, scannedAt: timestamp() }
        await this.saveIndex()
        this.scanStatus.finishedAt = timestamp()
      } catch (error) {
        this.scanStatus.error = error.message
      } finally {
        this.scanStatus.running = false
        this.scanPromise = null
        this.onChange()
      }
      if (this.config.onlineEnabled) void this.enrich().catch(() => {})
      return this.snapshot()
    })()
    return this.scanPromise
  }

  async readAlbum(root, entry, previous) {
    const id = albumEntryId(entry)
    let fileCover
    if (entry.cover) {
      const stat = await fs.stat(entry.cover)
      fileCover = { path: entry.cover, mime: imageMime(entry.cover), version: hash(`${entry.cover}:${stat.size}:${stat.mtimeMs}`), embedded: false }
    }
    // A single owns its embedded artwork; a matching image is only a fallback.
    let cover = entry.singleFile ? undefined : fileCover
    const tracks = []
    for (const file of entry.tracks) {
      const stat = await fs.stat(file)
      const fingerprint = `${stat.size}:${stat.mtimeMs}`
      const old = previous?.tracks.find((track) => track._path === file)
      if (old?._fingerprint === fingerprint && COMPATIBLE_METADATA_VERSIONS.has(old._metadataVersion) && (cover || old._embeddedCover !== undefined)) {
        tracks.push(old._metadataVersion === METADATA_VERSION ? old : { ...old, _metadataVersion: METADATA_VERSION })
        if (!cover && old._embeddedCover) cover = old._embeddedCover
        continue
      }
      let metadata
      let metadataError
      try { metadata = await this.parseFile(file, { duration: true, skipCovers: !!cover }) }
      catch (error) { metadataError = error.message; metadata = { common: {}, format: {} } }
      const common = metadata.common ?? {}
      let embedded = null
      if (!cover) {
        const picture = common.picture?.find((image) => /front/i.test(image.type ?? '')) ?? common.picture?.[0]
        if (picture?.data?.length && picture.data.length < 30 * 1024 * 1024) {
          const mime = picture.format === 'image/jpg' ? 'image/jpeg' : picture.format
          const extension = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' })[mime]
          if (extension) {
            const version = hash(picture.data)
            const target = path.join(this.dataDir, 'artwork', `${version}${extension}`)
            await fs.mkdir(path.dirname(target), { recursive: true })
            if (!(await exists(target))) await fs.writeFile(target, picture.data, { mode: 0o600 })
            embedded = { path: target, mime, version, embedded: true }
            cover = embedded
          }
        }
      }
      const extension = path.extname(file).toLowerCase()
      const trackId = `track-${hash(file)}`
      const discPrefix = path.basename(file).match(/^(\d{1,2})[-_](\d{1,3})(?:[\s._-]|$)/)
      const discNumber = numberOrUndefined(common.disk?.no) ?? (discPrefix ? numberOrUndefined(Number(discPrefix[1])) : undefined)
      const trackNumber = numberOrUndefined(common.track?.no) ?? (discPrefix ? numberOrUndefined(Number(discPrefix[2])) : undefined)
      tracks.push({
        id: trackId, albumId: id, title: text(common.title) || path.parse(file).name,
        artist: text(common.artist) || text(common.albumartist) || '未知艺术家',
        trackNumber, discNumber,
        duration: Number.isFinite(metadata.format?.duration) ? metadata.format.duration : 0,
        format: extension.slice(1).toUpperCase(), codec: metadata.format?.codec,
        bitsPerSample: numberOrUndefined(metadata.format?.bitsPerSample), sampleRate: numberOrUndefined(metadata.format?.sampleRate),
        bitrate: numberOrUndefined(metadata.format?.bitrate), numberOfChannels: numberOrUndefined(metadata.format?.numberOfChannels),
        lossless: typeof metadata.format?.lossless === 'boolean' ? metadata.format.lossless : undefined,
        browserPlayable: BROWSER_EXTENSIONS.has(extension), audioUrl: `/api/audio/${trackId}`,
        relativePath: path.relative(root, file),
        _path: file, _fingerprint: fingerprint, _metadataVersion: METADATA_VERSION,
        _common: {
          album: text(common.album), albumartist: text(common.albumartist), year: numberOrUndefined(common.year),
          genres: unique((common.genre ?? []).map(text)), producers: unique((common.producer ?? []).map(text)),
          credits: readLocalCredits(metadata, text(common.title) || path.parse(file).name, trackId),
          releaseId: firstString(common.musicbrainz_albumid), releaseGroupId: firstString(common.musicbrainz_releasegroupid),
          discTotal: numberOrUndefined(common.disk?.of), discNumberSource: common.disk?.no ? 'tag' : discPrefix ? 'filename' : undefined,
          comments: (common.comment ?? []).map((comment) => typeof comment === 'string' ? comment : text(comment.text)).filter(Boolean),
          ...(metadataError ? { metadataError } : {}),
        },
        _embeddedCover: cover && !embedded ? undefined : embedded,
      })
    }
    cover ??= fileCover
    tracks.sort((a, b) => (a.discNumber ?? 1) - (b.discNumber ?? 1) || (a.trackNumber ?? 9999) - (b.trackNumber ?? 9999) || a.relativePath.localeCompare(b.relativePath, 'zh-CN', { numeric: true }))
    const first = tracks[0]
    const localGenres = unique(tracks.flatMap((track) => track._common.genres))
    const releaseId = tracks.map((track) => track._common.releaseId).find((value) => MBID.test(value))
    const releaseGroupId = tracks.map((track) => track._common.releaseGroupId).find((value) => MBID.test(value))
    const title = entry.singleFile ? first?.title || path.parse(entry.singleFile).name : first?._common.album || path.basename(entry.folder)
    const artist = (entry.singleFile ? first?.artist : first?._common.albumartist || first?.artist) || '未知艺术家'
    const unchangedIdentity = previous && title === previous.title && artist === previous.artist && first?._common.year === previous.year && tracks.length === previous.tracks.length && (!releaseId || releaseId === previous.online?.releaseId)
    const unchangedCredits = previous && creditsIdentity(previous) === creditsIdentity({ tracks })
    return {
      id, title, artist, year: first?._common.year,
      discCount: Math.max(1, ...tracks.map((track) => track._common.discTotal ?? track.discNumber ?? 1)),
      localNote: unique(tracks.flatMap((track) => track._common.comments ?? [])).join('\n') || undefined,
      description: unchangedIdentity && previous.descriptionSource?.url ? previous.description : undefined,
      descriptionSource: unchangedIdentity && previous.descriptionSource?.url ? previous.descriptionSource : undefined,
      introduction: unchangedIdentity ? previous.introduction : undefined,
      genreId: 'unclassified', rawGenres: localGenres,
      folder: entry.folder, tracks, offline: false,
      producers: uniqueProducers([
        ...tracks.flatMap((track) => track._common.credits ?? track._common.producers.map((name) => ({ name, role: '制作人', source: 'local', trackTitle: track.title, trackId: track.id }))),
        ...(unchangedIdentity ? (previous.producers ?? []).filter((person) => !['local', 'QQ Music'].includes(person.source)) : []),
        ...(unchangedCredits ? (previous.producers ?? []).filter((person) => person.source === 'QQ Music') : []),
      ]),
      creditsLookup: unchangedCredits ? previous.creditsLookup : undefined,
      online: unchangedIdentity ? previous.online : { status: 'unqueried', releaseId, releaseGroupId },
      _root: root, _cover: cover, _localGenres: localGenres,
      _onlineGenres: unchangedIdentity ? previous._onlineGenres ?? [] : [],
    }
  }

  trackFile(id) {
    for (const album of this.index.albums) if (this.config.roots.includes(album._root)) {
      const track = album.tracks.find((entry) => entry.id === id)
      if (track) return { path: track._path, mime: audioMime(track._path), allowedRoot: album._root }
    }
    return null
  }

  artworkFile(id) {
    const album = this.index.albums.find((entry) => entry.id === id && this.config.roots.includes(entry._root))
    return album?._cover ? { ...album._cover, allowedRoot: album._cover.embedded ? this.dataDir : album._root } : null
  }

  async musicBrainz(endpoint, params = {}) {
    const url = new URL(`https://musicbrainz.org/ws/2/${endpoint}`)
    for (const [key, value] of Object.entries({ ...params, fmt: 'json' })) url.searchParams.set(key, value)
    return this.onlineJson(url)
  }

  async onlineJson(url) {
    if (!this.musicBrainzContact) throw new Error('请先配置自己的联系邮箱或项目网址，以满足 MusicBrainz User-Agent 要求')
    const wait = Math.max(0, this.lastMusicBrainzRequest + 1100 - Date.now())
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
    this.lastMusicBrainzRequest = Date.now()
    const response = await this.fetcher(url, {
      headers: { 'User-Agent': `RhineDroid/0.1 (${this.musicBrainzContact})`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000), redirect: 'error',
    })
    if (!response.ok) throw new Error(`${url.hostname} HTTP ${response.status}，保留本地资料，可稍后重试`)
    return response.json()
  }

  async albumIntroduction(group) {
    // Only follow links already attached to the confidently matched album group;
    // title-only encyclopedia searches can silently pick an unrelated work.
    const relations = group?.relations ?? []
    let language
    let title
    const wikidata = relations.find((relation) => relation.type === 'wikidata')?.url?.resource
    const qid = wikidata?.match(/^https?:\/\/(?:www\.)?wikidata\.org\/wiki\/(Q\d+)\/?$/)?.[1]
    if (qid) {
      const entity = await this.onlineJson(new URL(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`))
      const links = entity.entities?.[qid]?.sitelinks
      if (links?.zhwiki?.title) { language = 'zh'; title = links.zhwiki.title }
      else if (links?.enwiki?.title) { language = 'en'; title = links.enwiki.title }
    }
    if (!title) {
      const candidates = relations.map((relation) => relation.url?.resource).filter(Boolean).map((resource) => {
        try {
          const url = new URL(resource)
          const match = /^(zh|en)\.wikipedia\.org$/.exec(url.hostname)
          return match && url.pathname.startsWith('/wiki/') ? { language: match[1], title: decodeURIComponent(url.pathname.slice(6)).replaceAll('_', ' ') } : null
        } catch { return null }
      }).filter(Boolean).sort((a, b) => (a.language === 'zh' ? -1 : 1) - (b.language === 'zh' ? -1 : 1))
      if (candidates[0]) ({ language, title } = candidates[0])
    }
    if (!title) return null
    const api = new URL(`https://${language}.wikipedia.org/w/api.php`)
    const params = { action: 'query', format: 'json', formatversion: '2', prop: 'extracts|info|pageprops', inprop: 'url', ppprop: 'disambiguation', exintro: '1', explaintext: '1', exchars: '800', redirects: '1', titles: title }
    for (const [key, value] of Object.entries(params)) api.searchParams.set(key, value)
    const data = await this.onlineJson(api)
    const page = data.query?.pages?.find((entry) => !entry.missing && !Object.hasOwn(entry.pageprops ?? {}, 'disambiguation') && text(entry.extract))
    if (!page) return null
    return {
      description: text(page.extract),
      descriptionSource: { name: language === 'zh' ? '维基百科' : 'Wikipedia', url: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(page.title.replaceAll(' ', '_'))}`, checkedAt: timestamp(), license: 'CC BY-SA（以来源页为准）' },
    }
  }

  async enrich({ albumIds, force = false } = {}) {
    if (this.enrichPromise) return this.enrichPromise
    if (albumIds !== undefined && (!Array.isArray(albumIds) || albumIds.some((id) => typeof id !== 'string'))) throw new Error('albumIds 必须是专辑 ID 数组')
    const selected = this.index.albums.filter((album) => !album.offline && (!albumIds || albumIds.includes(album.id)) && (force || !album.online?.checkedAt))
    this.enrichStatus = { running: true, completed: 0, total: selected.length }
    this.enrichPromise = (async () => {
      // Yield once even for an empty queue so finally clears the assigned promise.
      await Promise.resolve()
      try {
        for (const album of selected) {
          await this.enrichAlbum(album)
          this.enrichStatus.completed += 1
          await this.saveIndex()
          this.onChange()
        }
      } catch (error) { this.enrichStatus.error = error.message }
      finally { this.enrichStatus.running = false; this.enrichPromise = null }
      return this.snapshot()
    })()
    return this.enrichPromise
  }

  async updateCredits({ albumIds, force = false } = {}) {
    if (albumIds !== undefined && (!Array.isArray(albumIds) || albumIds.length > 10000 || albumIds.some((id) => typeof id !== 'string'))) throw new Error('albumIds 必须是专辑 ID 数组')
    if (typeof force !== 'boolean') throw new Error('force 必须为布尔值')
    if (this.creditsPromise) return this.creditsPromise
    const selected = this.index.albums.filter((album) => {
      if (album.offline || !this.config.roots.includes(album._root) || (albumIds && !albumIds.includes(album.id))) return false
      if (force) return true
      const cached = album.creditsLookup
      if (!cached?.checkedAt) return true
      if (cached.status === 'matched') return false
      const ttl = cached.status === 'error' || cached.error ? 10 * 60_000 : 7 * 86400_000
      return Date.now() >= Math.max(Date.parse(cached.checkedAt) + ttl || 0, Date.parse(cached.retryAt) || 0)
    }).map((album) => ({
      id: album.id, title: album.title, artist: album.artist, identity: creditsIdentity(album),
      tracks: album.tracks.map((track) => ({ id: track.id, title: track.title, artist: track.artist, duration: track.duration, _common: { album: track._common?.album } })),
    }))
    this.creditsStatus = { running: true, completed: 0, total: selected.length, updated: 0, notFound: 0, failed: 0 }
    this.creditsPromise = (async () => {
      await Promise.resolve()
      let consecutiveFailures = 0
      try {
        for (const album of selected) {
          Object.assign(this.creditsStatus, { currentAlbum: album.title, trackCompleted: 0, trackTotal: album.tracks.length })
          this.onChange()
          let result
          try {
            result = await this.creditsProvider.lookup(album, { force, onProgress: ({ completed, total }) => {
              this.creditsStatus.trackCompleted = completed
              this.creditsStatus.trackTotal = total
              this.onChange()
            } })
          } catch (error) { result = { status: 'error', error: error.message, retryAt: error.retryAt } }
          if (!['matched', 'partial', 'not-found', 'uncertain', 'error'].includes(result?.status)) result = { status: 'error', error: '制作资料来源返回无效状态' }
          const current = this.index.albums.find((entry) => entry.id === album.id && this.config.roots.includes(entry._root))
          let before, outcome
          if (current && creditsIdentity(current) === album.identity) {
            before = { producers: current.producers, lookup: current.creditsLookup }
            const tracksById = new Map(current.tracks.map((track) => [track.id, track]))
            const credits = (Array.isArray(result.credits) ? result.credits : []).filter((person) => tracksById.has(person.trackId) && text(person.name) && text(person.role)).map((person) => ({
              name: text(person.name), role: text(person.role), source: 'QQ Music', trackId: person.trackId,
              trackTitle: tracksById.get(person.trackId).title,
              ...(typeof person.url === 'string' && /^https:\/\/y\.qq\.com\/n\/ryqq\/songDetail\/[A-Za-z0-9]+$/.test(person.url) ? { url: person.url } : {}),
            }))
            current.creditsLookup = {
              source: 'QQ Music', status: result.status, checkedAt: result.checkedAt ?? timestamp(),
              matchedTracks: Math.max(0, Math.min(album.tracks.length, Number(result.matchedTracks) || 0)), totalTracks: album.tracks.length,
              ...(result.error ? { error: result.error } : {}), ...(result.retryAt ? { retryAt: result.retryAt } : {}),
            }
            if (credits.length) {
              // A partial/network failure must not erase previously known credits.
              const refreshedTracks = new Set(credits.map((person) => person.trackId))
              current.producers = uniqueProducers([
                ...(current.producers ?? []).filter((person) => person.source !== 'QQ Music' || (result.status !== 'matched' && !refreshedTracks.has(person.trackId))),
                ...credits,
              ])
              outcome = 'updated'
            } else if (result.status === 'matched') {
              current.creditsLookup.status = 'not-found'
              outcome = 'notFound'
            } else if (result.status === 'error') outcome = 'failed'
            else outcome = 'notFound'
          }
          this.creditsStatus.completed += 1
          if (result.error) this.creditsStatus.error = result.error
          consecutiveFailures = result.status === 'error' ? consecutiveFailures + 1 : 0
          try { await this.saveIndex() }
          catch (error) {
            if (before) {
              current.producers = before.producers
              current.creditsLookup = { ...before.lookup, source: 'QQ Music', status: 'error', checkedAt: timestamp(), error: `本地制作信息缓存写入失败：${error.message}` }
              this.creditsStatus.failed += 1
            }
            throw error
          }
          if (outcome) this.creditsStatus[outcome] += 1
          this.onChange()
          if (Date.parse(result.retryAt) > Date.now() || consecutiveFailures >= 3) {
            const remaining = selected.length - this.creditsStatus.completed
            this.creditsStatus.error = `${result.error || '资料来源暂时不可用'}${remaining ? `；剩余 ${remaining} 张已暂停，已有资料保留。` : ''}`
            break
          }
        }
      } catch (error) { this.creditsStatus.error = `制作信息更新未完成：${error.message}` }
      finally {
        this.creditsStatus.running = false
        delete this.creditsStatus.currentAlbum
        delete this.creditsStatus.trackCompleted
        delete this.creditsStatus.trackTotal
        this.creditsPromise = null
        this.onChange()
      }
      return this.snapshot()
    })()
    return this.creditsPromise
  }

  async updateIntroductions({ albumIds, force = false } = {}) {
    if (this.introductionsPromise) return this.introductionsPromise
    if (albumIds !== undefined && (!Array.isArray(albumIds) || albumIds.length > 10000 || albumIds.some((id) => typeof id !== 'string'))) throw new Error('albumIds 必须是专辑 ID 数组')
    if (typeof force !== 'boolean') throw new Error('force 必须为布尔值')
    const selected = this.index.albums.filter((album) => {
      if (!this.config.roots.includes(album._root) || (albumIds && !albumIds.includes(album.id))) return false
      if (force) return true
      if (album.description && album.descriptionSource?.url) return false
      const cached = album.introduction
      return !cached || cached.status === 'error' || !cached.checkedAt || Date.now() - Date.parse(cached.checkedAt) > 7 * 86400_000
    }).map((album) => ({ id: album.id, title: album.title, artist: album.artist, year: album.year }))
    this.introductionsStatus = { running: true, completed: 0, total: selected.length, updated: 0, notFound: 0, failed: 0 }
    this.introductionsPromise = (async () => {
      await Promise.resolve()
      let consecutiveFailures = 0
      try {
        for (const album of selected) {
          this.introductionsStatus.currentAlbum = album.title
          this.onChange()
          let result
          try { result = await this.introductionProvider.lookup(album) }
          catch (error) { result = { status: 'error', checkedAt: timestamp(), error: error.message } }
          if (!['matched', 'not-found', 'uncertain', 'error'].includes(result?.status)) result = { status: 'error', checkedAt: timestamp(), error: '专辑介绍来源返回无效状态' }
          const current = this.index.albums.find((entry) => entry.id === album.id)
          if (current && current.title === album.title && current.artist === album.artist && current.year === album.year) {
            current.introduction = { status: result.status, checkedAt: result.checkedAt ?? timestamp(), ...(result.error ? { error: result.error } : {}), ...(result.candidateUrl ? { candidateUrl: result.candidateUrl } : {}) }
            if (result.status === 'matched' && result.description && result.descriptionSource?.url) {
              current.description = result.description
              current.descriptionSource = result.descriptionSource
              this.introductionsStatus.updated += 1
            } else if (result.status === 'error' || result.status === 'matched') {
              current.introduction.status = 'error'
              current.introduction.error ||= '来源未提供可引用的专辑介绍'
              this.introductionsStatus.failed += 1
            } else this.introductionsStatus.notFound += 1
          }
          this.introductionsStatus.completed += 1
          if (result.status === 'error') {
            consecutiveFailures += 1
            this.introductionsStatus.error = result.error
          } else consecutiveFailures = 0
          await this.saveIndex()
          this.onChange()
          if (consecutiveFailures >= 3 && this.introductionsStatus.completed < selected.length) {
            this.introductionsStatus.error = `百科来源连续 3 次访问失败，已暂停剩余 ${selected.length - this.introductionsStatus.completed} 张，避免重复超时。${result.error ?? ''}`
            break
          }
        }
      } catch (error) { this.introductionsStatus.error = `更新未完成：${error.message}` }
      finally {
        this.introductionsStatus.running = false
        delete this.introductionsStatus.currentAlbum
        this.introductionsPromise = null
        this.onChange()
      }
      return this.snapshot()
    })()
    return this.introductionsPromise
  }

  async enrichAlbum(album) {
    const checkedAt = timestamp()
    try {
      let releaseId = album.online?.releaseId
      if (!releaseId) {
        const escape = (value) => value.replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, '\\$&')
        const found = await this.musicBrainz('release', { query: `release:"${escape(album.title)}" AND artist:"${escape(album.artist)}"`, limit: '5' })
        const candidates = (found.releases ?? []).filter((candidate) =>
          normalized(candidate.title) === normalized(album.title) &&
          normalized((candidate['artist-credit'] ?? []).map((credit) => credit.name ?? credit.artist?.name ?? '').join('')) === normalized(album.artist) &&
          Number(candidate['track-count']) === album.tracks.length &&
          (!album.year || !candidate.date || candidate.date.startsWith(String(album.year))) && Number(candidate.score ?? 0) >= 95)
        // Multiple pressings are not interchangeable for production credits.
        if (candidates.length !== 1) {
          album.online = { ...album.online, status: found.releases?.length ? 'uncertain' : 'not-found', checkedAt }
          return
        }
        releaseId = candidates[0].id
      }
      if (!MBID.test(releaseId)) throw new Error('无效的 MusicBrainz Release ID')
      const release = await this.musicBrainz(`release/${releaseId}`, { inc: 'artist-credits+recordings+recording-level-rels+artist-rels+release-groups+genres' })
      const releaseGroupId = release['release-group']?.id ?? album.online?.releaseGroupId
      const group = releaseGroupId && MBID.test(releaseGroupId) ? await this.musicBrainz(`release-group/${releaseGroupId}`, { inc: 'genres+artist-rels+url-rels' }) : null
      const genres = [...(release.genres ?? []), ...(group?.genres ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).map((genre) => text(genre.name))
      const producers = []
      const collect = (relations = [], trackTitle) => {
        for (const relation of relations) if (/producer/i.test(relation.type ?? '') && relation.artist?.name) {
          producers.push({ name: relation.artist.name, role: relation.type, source: 'MusicBrainz', trackTitle, url: `https://musicbrainz.org/artist/${relation.artist.id}` })
        }
      }
      collect(release.relations)
      collect(group?.relations)
      for (const medium of release.media ?? []) for (const track of medium.tracks ?? []) collect(track.recording?.relations, track.title ?? track.recording?.title)
      const online = { status: 'matched', releaseId, releaseGroupId, checkedAt, sourceUrl: `https://musicbrainz.org/release/${releaseId}` }
      let introduction
      try {
        introduction = await this.albumIntroduction(group)
        online.descriptionStatus = introduction ? 'available' : 'not-found'
      } catch (error) {
        online.descriptionStatus = 'error'
        online.descriptionError = error.message
      }
      // Commit after all awaited requests, to the current record after any scan.
      const current = this.index.albums.find((entry) => entry.id === album.id)
      if (!current || current.title !== album.title || current.artist !== album.artist || current.year !== album.year) return
      current._onlineGenres = unique(genres)
      current.producers = uniqueProducers([...(current.producers ?? []).filter((person) => person.source !== 'MusicBrainz'), ...producers])
      current.online = online
      if (introduction) Object.assign(current, introduction)
      Object.assign(album, { _onlineGenres: current._onlineGenres, producers: current.producers, online: current.online, description: current.description, descriptionSource: current.descriptionSource })
    } catch (error) {
      album.online = { ...album.online, status: 'error', checkedAt, error: error.message }
      this.enrichStatus.error = error.message
    }
  }
}

function uniqueProducers(producers) {
  const seen = new Set()
  return producers.filter((producer) => {
    const key = JSON.stringify([producer.name, producer.role, producer.trackId ?? producer.trackTitle ?? '', producer.source])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
