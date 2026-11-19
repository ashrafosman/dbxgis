// Render the promo: serve promo/ locally, call renderFrame(f) for every frame, screenshot,
// then encode H.264 + AAC with ffmpeg.
//
// Usage: node render.mjs            full render → out/dbxgis-promo.mp4
//        node render.mjs --stills   a few preview stills → out/stills/
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const here = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(here, 'out');
const FRAMES = path.join(OUT, 'frames');
const stills = process.argv.includes('--stills');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.join(here, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(here) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(`http://localhost:${port}/compositor/index.html`);
await page.waitForFunction(() => window.compositorReady);
await page.evaluate(() => window.compositorReady);
const total = await page.evaluate(() => window.TOTAL_FRAMES);
const fpb = (30 * 60) / 128;

const stage = page.locator('#stage');
if (stills) {
  const dir = path.join(OUT, 'stills');
  fs.mkdirSync(dir, { recursive: true });
  const beats = [0.3, 2.4, 5.3, 10.6, 12.3, 15.7, 17.5, 19.2, 29.4, 33.6, 37.3, 42.3, 47.5, 53];
  for (const b of beats) {
    const f = Math.round(b * fpb);
    await page.evaluate((n) => window.renderFrame(n), f);
    await stage.screenshot({ path: path.join(dir, `b${String(b).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 85 });
  }
  console.log(`stills → ${dir}`);
} else {
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  const t0 = Date.now();
  for (let f = 0; f < total; f++) {
    await page.evaluate((n) => window.renderFrame(n), f);
    await stage.screenshot({ path: path.join(FRAMES, `${String(f).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 93 });
    if (f % 100 === 0) console.log(`frame ${f}/${total}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  const mp4 = path.join(OUT, 'dbxgis-promo.mp4');
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-y',
    '-framerate', '30', '-i', path.join(FRAMES, '%05d.jpg'),
    '-i', path.join(here, 'assets', 'audio', 'mix.wav'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000',
    '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart',
    mp4,
  ]);
  console.log(`video → ${mp4}`);
}

await browser.close();
server.close();
