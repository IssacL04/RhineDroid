// Original score; no recordings or melodies copied from the reference film.
// node scripts/render-audio.mjs [path/to/ffmpeg.exe]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const rate = 48000,
  bpm = 72,
  beat = 60 / bpm,
  duration = 64 * beat;
const length = Math.round(rate * duration),
  tau = Math.PI * 2;
const folder = "public/audio";
fs.mkdirSync(folder, { recursive: true });
fs.mkdirSync(".tools/audio-render", { recursive: true });
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
let seed = 93271;
const random = () =>
  ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const stems = Object.fromEntries(
  ["atmosphere", "motif", "pulse"].map((k) => [
    k,
    [new Float32Array(length), new Float32Array(length)],
  ]),
);
function add(stem, start, seconds, pan, synth) {
  const out = stems[stem],
    offset = Math.round(start * rate);
  const l = Math.cos(((pan + 1) * Math.PI) / 4),
    r = Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < Math.round(seconds * rate); i++) {
    const sample = synth(i / rate, i / (seconds * rate));
    const index = (((offset + i) % length) + length) % length;
    out[0][index] += sample * l;
    out[1][index] += sample * r;
  }
}
// Dmaj9 / Bm11 / Gmaj9 / Asus2, followed by a quieter answer.
const chords = [
  [50, 57, 61, 64, 69],
  [47, 54, 57, 62, 64],
  [43, 54, 57, 62, 66],
  [45, 52, 57, 59, 64],
  [50, 57, 61, 64, 66],
  [47, 54, 57, 61, 64],
  [43, 50, 57, 59, 66],
  [45, 52, 57, 62, 64],
];
for (let bar = 0; bar < 8; bar++) {
  chords[bar].forEach((note, voice) => {
    const f = hz(note),
      seconds = beat * 10;
    add(
      "atmosphere",
      bar * 8 * beat - beat,
      seconds,
      (voice - 2) * 0.28,
      (t, p) => {
        const env = Math.sin(Math.PI * p) ** 2;
        const drift = 0.003 * Math.sin(tau * 0.17 * t + voice);
        return (
          0.035 *
          env *
          (Math.sin(tau * f * t + drift) +
            0.22 * Math.sin(tau * f * 2 * t) +
            0.12 * Math.sin(tau * f * 1.0007 * t))
        );
      },
    );
  });
  // Quiet sub pulse, like equipment breathing, only twice per two-bar phrase.
  for (const b of [0, 4.5])
    add(
      "pulse",
      (bar * 8 + b) * beat,
      1.5,
      0,
      (t, p) =>
        0.12 *
        (1 - Math.exp(-t * 20)) *
        Math.exp(-t * 4) *
        (1 - p) *
        Math.sin(tau * hz(chords[bar][0] - 12) * t),
    );
  for (const b of [1.5, 3, 5.5, 7])
    add(
      "pulse",
      (bar * 8 + b) * beat,
      0.085,
      b < 4 ? -0.3 : 0.3,
      (t, p) =>
        0.018 *
        Math.sin(Math.PI * p) *
        Math.exp(-t * 55) *
        (random() * 0.35 + Math.sin(tau * 1240 * t) * 0.65),
    );
}
// Spacious, hand-written question/answer phrases, with deliberate rests.
const phrases = [
  [
    [0, 74],
    [2.5, 76],
    [5, 69],
  ],
  [
    [1, 73],
    [4, 69],
  ],
  [
    [0, 71],
    [3, 74],
    [6, 78],
  ],
  [
    [2, 76],
    [5.5, 71],
  ],
  [
    [0, 78],
    [3, 76],
    [6, 73],
  ],
  [
    [1, 74],
    [4.5, 69],
  ],
  [
    [0, 71],
    [2.5, 69],
    [6, 66],
  ],
  [
    [1, 69],
    [4, 76],
  ],
];
phrases.forEach((phrase, bar) =>
  phrase.forEach(([b, note], i) => {
    const f = hz(note),
      velocity = 0.12 * (i === 0 ? 1 : 0.78);
    for (let echo = 0; echo < 4; echo++) {
      add(
        "motif",
        (bar * 8 + b) * beat + echo * beat * 0.75,
        4.8,
        (i % 2 ? 0.22 : -0.22) * (echo % 2 ? -1 : 1),
        (t, p) => {
          const attack = 1 - Math.exp(-t * 110),
            end = Math.min(1, (1 - p) * 12);
          const body = Math.sin(
            tau * f * t + 0.65 * Math.exp(-t * 7) * Math.sin(tau * f * 2 * t),
          );
          return (
            velocity *
            0.27 ** echo *
            attack *
            end *
            Math.exp(-t * 1.2) *
            (body +
              0.24 * Math.exp(-t * 2) * Math.sin(tau * f * 3 * t) +
              0.035 * Math.exp(-t * 8) * random())
          );
        },
      );
    }
  }),
);
// Circular, decorrelated early reflections keep the loop continuous.
for (const [name, channels] of Object.entries(stems)) {
  const original = channels.map((c) => c.slice());
  for (const [seconds, gain] of [
    [0.071, 0.17],
    [0.113, 0.13],
    [0.193, 0.09],
    [0.307, 0.065],
    [0.487, 0.04],
  ]) {
    const delay = Math.round(seconds * rate);
    for (let c = 0; c < 2; c++)
      for (let i = 0; i < length; i++)
        channels[c][(i + delay) % length] += original[1 - c][i] * gain;
  }
  if (name === "atmosphere")
    for (let c = 0; c < 2; c++) {
      let last = channels[c][length - 1];
      for (let i = 0; i < length; i++) {
        last += 0.16 * (channels[c][i] - last);
        channels[c][i] = last;
      }
    }
}
function wav(channels, file) {
  const data = Buffer.alloc(44 + length * 4);
  data.write("RIFF");
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(length * 4, 40);
  for (let i = 0; i < length; i++)
    for (let c = 0; c < 2; c++)
      data.writeInt16LE(
        Math.round(Math.max(-1, Math.min(1, channels[c][i])) * 32767),
        44 + i * 4 + c * 2,
      );
  fs.writeFileSync(file, data);
}
const mix = [new Float32Array(length), new Float32Array(length)];
const metrics = {};
for (const [name, channels] of Object.entries(stems)) {
  for (const channel of channels)
    for (let i = 0; i < length; i++) channel[i] *= 2.2;
  let peak = 0,
    square = 0;
  for (let c = 0; c < 2; c++)
    for (let i = 0; i < length; i++) {
      const x = channels[c][i];
      peak = Math.max(peak, Math.abs(x));
      square += x * x;
      mix[c][i] += x;
    }
  metrics[name] = {
    peakDb: 20 * Math.log10(peak),
    rmsDb: 10 * Math.log10(square / (length * 2)),
    seamDelta: Math.max(...channels.map((c) => Math.abs(c[0] - c[length - 1]))),
  };
  const file = path.join(".tools/audio-render", name + ".wav");
  wav(channels, file);
  if (process.argv[2])
    execFileSync(process.argv[2], [
      "-y",
      "-v",
      "error",
      "-i",
      file,
      "-c:a",
      "libvorbis",
      "-q:a",
      "5",
      path.join(folder, name + ".ogg"),
    ]);
}
wav(mix, ".tools/audio-render/observatory.wav");
if (process.argv[2])
  execFileSync(process.argv[2], [
    "-y",
    "-v",
    "error",
    "-i",
    ".tools/audio-render/observatory.wav",
    "-af",
    "afade=t=in:d=1,afade=t=out:st=50.833333:d=2.5",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "192k",
    path.join(folder, "observatory-preview.mp3"),
  ]);
fs.writeFileSync(
  path.join(folder, "score.json"),
  JSON.stringify(
    {
      title: "Observatory / 观测室",
      bpm,
      duration,
      rate,
      seed: 93271,
      metrics,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ duration, metrics }, null, 2));
