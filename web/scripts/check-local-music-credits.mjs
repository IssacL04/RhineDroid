import test from 'node:test'
import assert from 'node:assert/strict'
import { readLocalCredits } from './local-music-credits.mjs'

const read = (metadata, title = '测试曲目', id = 'track-fixture') => readLocalCredits(metadata, title, id)
const compact = (credits) => credits.map(({ name, role }) => [name, role])

test('common credit fields preserve distinct responsibilities and group names', () => {
  const credits = read({ common: {
    producer: ['制作甲'], composer: [' 作曲甲 ', 'AC/DC'], lyricist: ['作词甲'],
    writer: ['作者甲'], conductor: ['指挥甲'], arranger: ['编曲甲'], engineer: ['工程甲'],
    remixer: ['重混甲'], djmixer: ['DJ甲'], mixer: ['混音甲'],
  } })
  assert.deepEqual(compact(credits), [
    ['制作甲', '制作人'], ['作曲甲', '作曲'], ['AC/DC', '作曲'], ['作词甲', '作词'],
    ['作者甲', '作者'], ['指挥甲', '指挥'], ['编曲甲', '编曲'], ['工程甲', '音频工程'],
    ['重混甲', '重混音'], ['DJ甲', 'DJ 混音'], ['混音甲', '混音'],
  ])
  assert.ok(credits.every((credit) => credit.source === 'local' && credit.trackId === 'track-fixture' && credit.trackTitle === '测试曲目'))
})

test('native ID3 people objects expose explicit roles absent from common tags', () => {
  const credits = read({ native: {
    'ID3v2.4': [
      { id: 'TMCL', value: { guitar: ['乐手甲'], piano: ['乐手乙'] } },
      { id: 'TIPL', value: { producer: ['制作甲'], 'mastering engineer': ['母带甲'], 'tape operator': ['磁带甲'] } },
    ],
    'ID3v2.3': [{ id: 'IPLS', value: { mix: ['混音甲'], arranger: ['编曲甲'] } }],
  } })
  assert.deepEqual(compact(credits), [
    ['乐手甲', '吉他'], ['乐手乙', '钢琴'], ['制作甲', '制作人'],
    ['母带甲', '母带工程'], ['磁带甲', 'tape operator'], ['混音甲', '混音'], ['编曲甲', '编曲'],
  ])
})

test('Vorbis performers require explicit recognizable instrument or vocal suffixes', () => {
  const credits = read({ native: { vorbis: [
    { id: 'PERFORMER', value: '乐手甲 (electric guitar, vocals)' },
    { id: 'performer', value: ['乐手乙（钢琴）', '姓名带括号 (Alias) (drums)'] },
    { id: 'PERFORMER', value: '没有职责的人' },
    { id: 'PERFORMER', value: '歌手甲 (Beijing)' },
    { id: 'PERFORMER', value: '歌手乙 (1988)' },
    { id: 'PERFORMER', value: '歌手丙 (piano, unverified note)' },
    { id: 'PERFORMER', value: '歌手丁 (producer)' },
  ] } })
  assert.deepEqual(compact(credits), [
    ['乐手甲', '电吉他'], ['乐手甲', '人声'], ['乐手乙', '钢琴'], ['姓名带括号 (Alias)', '鼓'],
  ])
})

test('duplicates across common and native are removed while roles and track identities remain distinct', () => {
  const metadata = { common: { producer: [' Person ', 'person'], composer: ['Person'] }, native: {
    'ID3v2.4': [{ id: 'TIPL', value: { producer: ['PERSON'], composer: ['Person'] } }],
  } }
  assert.deepEqual(compact(read(metadata)), [['Person', '制作人'], ['Person', '作曲']])
  const first = read(metadata, '同名歌', 'track-a')
  const second = read(metadata, '同名歌', 'track-b')
  assert.equal(first.length + second.length, 4)
  assert.notEqual(first[0].trackId, second[0].trackId)
})

test('comments, lyrics, artwork and unrelated native tags never become credits', () => {
  assert.deepEqual(read({ common: {
    comment: [{ text: '作曲：不应读取' }], lyrics: [{ text: '作词：不应读取' }],
    artist: '不推断主唱', picture: [{ description: 'producer: not a credit' }],
  }, native: {
    'ID3v2.4': [{ id: 'COMM', value: { producer: ['不应读取'] } }, { id: 'USLT', value: '作曲：不应读取' }],
    vorbis: [{ id: 'COMMENT', value: '作曲：不应读取' }, { id: 'LYRICS', value: '词曲：不应读取' }],
    unrelated: [{ id: 'TIPL', value: { producer: ['不应读取'] } }],
  } }), [])
})

test('malformed tags are ignored and metadata remains unchanged', () => {
  const metadata = { common: { composer: [' 合法名字 ', null, {}, 42, '', 'bad\nname'], producer: '制作甲' }, native: {
    'ID3v2.4': [null, { id: 'TIPL', value: ['not a role map'] }, { id: 'TMCL', value: { guitar: [null, {}], 'bad\nrole': ['name'] } }],
    vorbis: [{ id: 'PERFORMER', value: {} }], other: null,
  } }
  const original = structuredClone(metadata)
  assert.deepEqual(compact(read(metadata)), [['制作甲', '制作人'], ['合法名字', '作曲']])
  assert.deepEqual(metadata, original)
  assert.deepEqual(read(undefined), [])
})
