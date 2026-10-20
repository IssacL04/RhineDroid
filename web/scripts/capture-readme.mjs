// Run against a local dev server. Requires Playwright, Chrome and FFmpeg.
// PLAYWRIGHT_MODULE may point to an existing Playwright index.mjs.
// FFMPEG may point to an existing ffmpeg executable.
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href
    : "playwright"
);
const ffmpeg = process.env.FFMPEG || "ffmpeg";
const base = process.env.CAPTURE_URL || "http://127.0.0.1:5186";
const output = resolve("docs/media");
const temporary = resolve(".tools/readme-capture");
await mkdir(output, { recursive: true });
await mkdir(temporary, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args:
    process.platform === "win32"
      ? ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"]
      : ["--enable-gpu"],
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
const session = await context.newCDPSession(page);
const manifest = {
  commit: spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim(),
  capturedAt: new Date().toISOString(),
  viewport: "1600x900",
  quality: "original",
  gifs: [],
  screenshots: [],
  errors,
};
const wait = (ms) => page.waitForTimeout(ms);
const click = (selector) => page.locator(selector).click();
async function shot(name) {
  await page.mouse.move(1580, 880);
  await page.screenshot({
    path: resolve(output, `${name}.jpg`),
    type: "jpeg",
    quality: 93,
  });
  manifest.screenshots.push(name);
}
function encode(args) {
  const result = spawnSync(
    ffmpeg,
    ["-y", "-hide_banner", "-loglevel", "error", ...args],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || `FFmpeg failed: ${result.error}`);
}
async function record(name, actions, width = 800) {
  const fps = name === "browse" ? 8 : 12;
  if (name === "browse") width = 640;
  const folder = resolve(temporary, `${name}-${Date.now()}`);
  await mkdir(folder, { recursive: true });
  const frames = [];
  const writes = [];
  const onFrame = (event) => {
    const filename = `frame-${String(frames.length).padStart(5, "0")}.jpg`;
    frames.push({ filename, timestamp: event.metadata.timestamp });
    writes.push(
      writeFile(resolve(folder, filename), Buffer.from(event.data, "base64")),
    );
    void session
      .send("Page.screencastFrameAck", { sessionId: event.sessionId })
      .catch(() => {});
  };
  session.on("Page.screencastFrame", onFrame);
  await session.send("Page.startScreencast", {
    format: "jpeg",
    quality: 92,
    maxWidth: 1600,
    maxHeight: 900,
    everyNthFrame: 3,
  });
  try {
    await wait(250);
    await actions();
  } finally {
    await session.send("Page.stopScreencast");
    session.off("Page.screencastFrame", onFrame);
    await Promise.all(writes);
  }
  if (frames.length < 10) throw new Error(`Too few frames for ${name}`);
  const intervals = frames
    .slice(1)
    .map((frame, i) => frame.timestamp - frames[i].timestamp);
  const duration = frames.at(-1).timestamp - frames[0].timestamp;
  await writeFile(
    resolve(folder, "frames.txt"),
    frames
      .map(
        (frame, i) =>
          `file '${frame.filename}'\nduration ${intervals[i] || 1 / 12}\n`,
      )
      .join("") + `file '${frames.at(-1).filename}'\n`,
  );
  encode([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    resolve(folder, "frames.txt"),
    "-vf",
    `fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    "-loop",
    "0",
    resolve(output, `${name}.gif`),
  ]);
  manifest.gifs.push({
    name,
    frames: frames.length,
    duration,
    width,
    fps,
    averageCaptureFps: frames.length / duration,
    maximumFrameGap: Math.max(...intervals),
  });
  console.log(
    `Captured ${name}: ${duration.toFixed(2)}s, ${frames.length} source frames`,
  );
}
try {
  await page.goto(`${base}/?scene=archive`);
  await page.waitForFunction(
    () => window.rhine?.stats().ready && !document.querySelector("#loading"),
    null,
    { timeout: 60000 },
  );
  await page.evaluate(() => document.fonts.ready);
  await wait(6000);
  await shot("archive");
  await record("browse", async () => {
    for (const key of [
      "ArrowDown",
      "ArrowDown",
      "ArrowRight",
      "ArrowDown",
      "ArrowRight",
      "ArrowLeft",
      "ArrowLeft",
    ]) {
      await page.keyboard.press(key);
      await wait(700);
    }
    await wait(1000);
  });
  await page.evaluate(() => window.rhine.select(0));
  await wait(1600);
  await record(
    "decryption",
    async () => {
      await page.keyboard.press("Enter");
      await wait(7500);
    },
    960,
  );
  await page.waitForFunction(
    () => window.rhine.stats().decryption.phase === "clear",
  );
  await shot("detail");
  await click('[data-tab="notes"]');
  await wait(450);
  await shot("research");
  await click('[data-action="model-viewer"]');
  await page.waitForFunction(
    () => document.querySelector('[data-viewer="explode"]')?.disabled === false,
  );
  await wait(1700);
  await shot("viewer-clear");
  await record("glass-motion", async () => {
    await click('[data-viewer="frosted"]');
    await wait(1700);
    await shot("viewer-frosted");
    await click('[data-viewer="clear"]');
    await wait(1700);
  });
  await record("assembly-motion", async () => {
    await click('[data-viewer="explode"]');
    await wait(1800);
    await shot("assembly");
    await page.mouse.move(850, 460);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(850 + i * 6, 460 + i);
      await wait(25);
    }
    await page.mouse.up();
    await wait(600);
    await click('[data-viewer="reset"]');
    await wait(850);
    await click('[data-viewer="assemble"]');
    await wait(1800);
  });
  await click('[data-viewer="close"]');
  await wait(450);
  await page.keyboard.press("Escape");
  await wait(1800);
  await click('[data-action="search"]');
  await wait(400);
  await page.locator("#archive-search").fill("莱茵");
  await wait(500);
  await shot("search");
  await page.keyboard.press("Escape");
  await wait(350);
  await click('[data-action="settings"]');
  await wait(400);
  await shot("settings");
  await page.keyboard.press("Escape");
  await wait(350);
  await record("boot-motion", async () => {
    await click('[data-action="replay"]');
    await wait(6500);
    await shot("boot");
    await wait(13000);
  });
  manifest.stats = await page.evaluate(() => window.rhine.stats());
  await writeFile(
    resolve(temporary, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  if (errors.length) throw new Error(errors.join("\n"));
  const { stats, ...publicManifest } = manifest;
  await writeFile(
    resolve(output, "capture.json"),
    JSON.stringify(publicManifest, null, 2) + "\n",
  );
} finally {
  await browser.close();
}
