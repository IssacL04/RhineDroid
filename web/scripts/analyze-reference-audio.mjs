// Read the local source only; emit measured levels, not a subjective listening report.
// node scripts/analyze-reference-audio.mjs path/to/ffmpeg.exe
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const video = fs.readdirSync(".").find((x) => x.endsWith(".mp4"));
if (!video || !process.argv[2])
  throw Error("Local reference video and ffmpeg path required");
const rate = 24000;
const pcm = execFileSync(
  process.argv[2],
  [
    "-v",
    "error",
    "-ss",
    "6.76",
    "-i",
    video,
    "-t",
    "33.24",
    "-vn",
    "-af",
    "pan=mono|c0=0.5*c0+0.5*c1",
    "-ac",
    "1",
    "-ar",
    String(rate),
    "-f",
    "f32le",
    "pipe:1",
  ],
  { maxBuffer: 16 * 1024 * 1024 },
);
const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
const bounds = [6.76, 9.16, 11.12, 19.48, 22.76, 26.92, 30.68, 33.3, 40];
const stages = bounds.slice(0, -1).map((start, i) => {
  const data = samples.subarray(
    Math.round((start - 6.76) * rate),
    Math.round((bounds[i + 1] - 6.76) * rate),
  );
  let peak = 0,
    sum = 0;
  for (const x of data) {
    peak = Math.max(peak, Math.abs(x));
    sum += x * x;
  }
  return {
    start,
    end: bounds[i + 1],
    peakDb: +(20 * Math.log10(peak)).toFixed(2),
    rmsDb: +(10 * Math.log10(sum / data.length)).toFixed(2),
  };
});
fs.writeFileSync(
  "reference/audio-analysis.json",
  JSON.stringify(
    {
      video,
      scope:
        "6.76–40 s, mono downmix; not a transcription or melody identification",
      stages,
    },
    null,
    2,
  ) + "\n",
);
console.log(stages);
