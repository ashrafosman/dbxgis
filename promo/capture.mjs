// Frame-accurate footage of the real demo app for the promo.
// Drives the app's ?capture hooks: picks a scene, sets the animation progress t for every frame,
// waits for MapLibre to finish drawing, and saves a 2x screenshot. Also records where the map,
// SQL and result table sit on screen so the compositor can crop them.
//
// Usage: node capture.mjs [appUrl]   (default http://localhost:5180/ — run `bun run dev` at the repo root)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const APP = process.argv[2] ?? 'http://localhost:5180/';
const here = path.dirname(new URL(import.meta.url).pathname);
const tl = JSON.parse(fs.readFileSync(path.join(here, 'timeline.json'), 'utf8'));
const OUT = path.join(here, 'assets', 'clips');
const FPB = (tl.fps * 60) / tl.bpm; // frames per beat
const CLIP_FRAMES = Math.ceil(FPB * 4) + 2;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto(`${APP}?capture#${tl.clips[0].scene}`);
await page.waitForFunction(() => window.__demo && window.__mapIdle);
await page.evaluate(() => document.fonts.ready);

const settle = () =>
  page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await window.__mapIdle();
  });
const rect = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, sel);

async function openScene(scene) {
  await page.evaluate((id) => window.__demo.setScene(id), scene);
  await page.waitForTimeout(2200); // camera ease is 1.4 s
  await page.evaluate(() => window.__demo.setT(0));
  await settle();
}

for (const clip of tl.clips) {
  const dir = path.join(OUT, clip.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await openScene(clip.scene);
  const frames = [];
  for (let i = 0; i < CLIP_FRAMES; i++) {
    const t = clip.t[0] + ((clip.t[1] - clip.t[0]) * i) / (CLIP_FRAMES - 1);
    await page.evaluate((v) => window.__demo.setT(v), t);
    await settle();
    const file = `${String(i).padStart(4, '0')}.jpg`;
    await page.screenshot({ path: path.join(dir, file), type: 'jpeg', quality: 90 });
    frames.push({ file, caption: await page.evaluate(() => document.querySelector('.caption')?.textContent?.replace(/^\d+\/\d+/, '') ?? '') });
  }
  const meta = {
    id: clip.id,
    viewport: { w: 1440, h: 900, dpr: 2 },
    map: await rect('.stage'),
    sql: await rect('.sql'),
    table: await rect('.table-wrap'),
    frames,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(`captured ${clip.id}: ${frames.length} frames`);
}

// Basemap swap: final state of one scene under each basemap.
{
  const bm = tl.basemaps;
  const dir = path.join(OUT, 'basemaps');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await openScene(bm.scene);
  await page.evaluate(() => window.__demo.setT(1));
  for (const id of bm.order) {
    await page.evaluate((b) => window.__demo.setBasemap(b), id);
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.__demo.setT(0.999));
    await page.evaluate(() => window.__demo.setT(1));
    await settle();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(dir, `${id}.jpg`), type: 'jpeg', quality: 90 });
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ map: await rect('.stage') }, null, 2));
  console.log('captured basemaps');
}

await browser.close();
