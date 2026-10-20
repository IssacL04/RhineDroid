const COMMON_ROLES = {
  producer: '制作人',
  composer: '作曲',
  lyricist: '作词',
  writer: '作者',
  conductor: '指挥',
  arranger: '编曲',
  engineer: '音频工程',
  remixer: '重混音',
  djmixer: 'DJ 混音',
  mixer: '混音',
}

// Only translate roles that a tag explicitly supplies. An unspecified engineer
// is not necessarily the recording or mastering engineer.
const ROLE_ALIASES = new Map([
  ...Object.entries(COMMON_ROLES),
  ...Object.values(COMMON_ROLES).map((role) => [role.toLowerCase(), role]),
  ['production', '制作人'], ['mix', '混音'], ['mixing', '混音'],
  ['mixing engineer', '混音工程'], ['mastering', '母带处理'],
  ['mastering engineer', '母带工程'], ['recording engineer', '录音工程'],
  ['assistant engineer', '助理音频工程'], ['dj-mix', 'DJ 混音'],
  ['作詞', '作词'], ['編曲', '编曲'], ['製作人', '制作人'], ['指揮', '指挥'],
])

// PERFORMER is a free-text Vorbis field. Accept a trailing parenthesis only
// when every item in it is a known instrument or vocal role, not a location,
// nickname, date, or inferred responsibility.
const INSTRUMENT_ROLES = new Map([
  ['guitar', '吉他'], ['acoustic guitar', '木吉他'], ['electric guitar', '电吉他'],
  ['bass', '贝斯'], ['bass guitar', '贝斯'], ['electric bass', '电贝斯'],
  ['double bass', '低音提琴'], ['upright bass', '低音提琴'],
  ['drums', '鼓'], ['drum kit', '架子鼓'], ['percussion', '打击乐'],
  ['piano', '钢琴'], ['keyboards', '键盘'], ['keyboard', '键盘'],
  ['synthesizer', '合成器'], ['organ', '管风琴'],
  ['violin', '小提琴'], ['viola', '中提琴'], ['cello', '大提琴'], ['strings', '弦乐'],
  ['flute', '长笛'], ['clarinet', '单簧管'], ['saxophone', '萨克斯'],
  ['trumpet', '小号'], ['trombone', '长号'], ['harmonica', '口琴'],
  ['harp', '竖琴'], ['accordion', '手风琴'],
  ['erhu', '二胡'], ['pipa', '琵琶'], ['guzheng', '古筝'],
  ['vocals', '人声'], ['vocal', '人声'], ['lead vocals', '主唱'],
  ['backing vocals', '和声'], ['background vocals', '和声'], ['chorus', '合唱'],
])
for (const role of [...INSTRUMENT_ROLES.values()]) INSTRUMENT_ROLES.set(role, role)

const clean = (value) => typeof value === 'string' ? value.trim().normalize('NFKC') : ''
const key = (value) => clean(value).toLowerCase().replace(/\s+/gu, ' ')
const strings = (value) => (Array.isArray(value) ? value : [value]).filter((item) => typeof item === 'string')
const validText = (value, maxLength) => value && value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value)

function explicitRole(value) {
  const role = clean(value)
  if (!validText(role, 100)) return ''
  return ROLE_ALIASES.get(key(role)) ?? INSTRUMENT_ROLES.get(key(role)) ?? role
}

/** Read only structured local credits; never infer credits from comments or lyrics. */
export function readLocalCredits(metadata, trackTitle, trackId) {
  const credits = []
  const seen = new Set()
  const add = (nameValue, roleValue) => {
    const name = clean(nameValue)
    const role = explicitRole(roleValue)
    if (!validText(name, 300) || !role) return
    const identity = JSON.stringify([key(name), key(role), trackId, trackTitle])
    if (seen.has(identity)) return
    seen.add(identity)
    credits.push({ name, role, source: 'local', trackTitle, trackId })
  }

  for (const [field, role] of Object.entries(COMMON_ROLES)) {
    for (const name of strings(metadata?.common?.[field])) add(name, role)
  }

  for (const [format, tags] of Object.entries(metadata?.native ?? {})) {
    if (!Array.isArray(tags)) continue
    for (const tag of tags) {
      const id = clean(tag?.id).toUpperCase()
      if (/^ID3v2\.[234]$/i.test(format) && ['TMCL', 'TIPL', 'IPLS'].includes(id)) {
        // music-metadata's ID3 FrameParser returns an object of role -> names[].
        const people = tag.value
        if (!people || typeof people !== 'object' || Array.isArray(people)) continue
        for (const [role, names] of Object.entries(people)) {
          for (const name of strings(names)) add(name, role)
        }
      } else if (/^vorbis$/i.test(format) && id === 'PERFORMER') {
        for (const value of strings(tag.value)) {
          const match = /^(.+?)\s*\(([^()]+)\)$/u.exec(clean(value))
          if (!match) continue
          const roles = match[2].split(/[,，、;/]/u).map((part) => INSTRUMENT_ROLES.get(key(part)))
          if (roles.some((role) => !role)) continue
          for (const role of roles) add(match[1], role)
        }
      }
    }
  }
  return credits
}
