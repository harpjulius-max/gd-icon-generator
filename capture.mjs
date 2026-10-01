// Renders GD icons to looping GIFs by stepping the page's CSS bob animation frame by frame.
// Input: JOBS env var = JSON array of { form, icon, col1, col2, glow }.
import { chromium } from "playwright";
import gifenc from "gifenc";
import pkg from "pngjs";
import fs from "node:fs";
import path from "node:path";

const { PNG } = pkg;
const { GIFEncoder, quantize, applyPalette } = gifenc;

const FORMS = ["cube", "ship", "ball", "ufo", "wave", "robot", "spider", "swing", "jetpack"];
const BASE_URL = process.env.BASE_URL || "http://localhost:8080/index.html";
const OUT_DIR = process.env.OUT_DIR || "../renders";
const BG = process.env.BG || "000000"; // hex, no '#'; must match what the sheet expects
const FRAMES = 24;                      // frames per loop
const LOOP_MS = 1600;                   // must match the CSS bob duration in index.html
const SIZE = 300;                       // page viewport size

// The file name is derived here from validated numbers, never taken from the request.
export function fileName(j) {
  return `${j.form}-${j.icon}-${j.col1}-${j.col2}-${j.glow ? 1 : 0}.gif`;
}

function validate(raw) {
  const int = (v) => (Number.isInteger(+v) && +v >= 0 && +v < 10000 ? +v : null);
  const j = { form: String(raw.form), icon: int(raw.icon), col1: int(raw.col1), col2: int(raw.col2), glow: raw.glow === true || raw.glow === "true" };
  if (!FORMS.includes(j.form) || j.icon === null || j.col1 === null || j.col2 === null) return null;
  return j;
}

async function renderOne(page, j, outPath) {
  const url = `${BASE_URL}?form=${j.form}&icon=${j.icon}&col1=${j.col1}&col2=${j.col2}&glow=${j.glow}&bg=${BG}`;
  await page.goto(url);
  await page.waitForFunction(() => window.__ready !== undefined, null, { timeout: 30000 });
  if ((await page.evaluate(() => window.__ready)) !== true) throw new Error("page reported an error");

  const gif = GIFEncoder();
  for (let i = 0; i < FRAMES; i++) {
    const t = (i * LOOP_MS) / FRAMES;
    await page.evaluate((time) => {
      document.getAnimations().forEach((a) => { a.pause(); a.currentTime = time; });
      return new Promise((r) => requestAnimationFrame(() => r()));
    }, t);
    const png = PNG.sync.read(await page.screenshot({ type: "png" }));
    const palette = quantize(png.data, 256);
    const index = applyPalette(png.data, palette);
    gif.writeFrame(index, png.width, png.height, { palette, delay: Math.round(LOOP_MS / FRAMES) });
  }
  gif.finish();
  fs.writeFileSync(outPath, gif.bytes());
}

async function main() {
  const raw = JSON.parse(process.env.JOBS || "[]");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const jobs = raw.map(validate).filter(Boolean);
  const todo = jobs.filter((j) => !fs.existsSync(path.join(OUT_DIR, fileName(j))));
  console.log(`${raw.length} requested, ${jobs.length} valid, ${todo.length} to render (rest cached)`);
  if (!todo.length) return;

  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
  page.on("console", (m) => console.log("  [page]", m.text()));
  page.on("pageerror", (e) => console.log("  [page error]", e.message));

  let failed = 0;
  for (const j of todo) {
    const out = path.join(OUT_DIR, fileName(j));
    try {
      await renderOne(page, j, out);
      console.log("rendered", fileName(j));
    } catch (e) {
      failed++;
      console.error("FAILED", fileName(j), e.message);
    }
  }
  await browser.close();
  if (failed) process.exitCode = 1; // other renders are still committed by the workflow
}

main();
