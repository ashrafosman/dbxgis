// Promo compositor: renderFrame(f) draws frame f of the 1080x1920 video as a pure function of f.
// render.mjs calls it for every frame and screenshots the stage.
const ROOT = '..';
const TL = await (await fetch(`${ROOT}/timeline.json`)).json();
const FPS = TL.fps;
const FPB = (FPS * 60) / TL.bpm;
export const TOTAL_FRAMES = Math.ceil((TL.beats + TL.tailBeats) * FPB);

const META = {};
for (const c of TL.clips) META[c.id] = await (await fetch(`${ROOT}/assets/clips/${c.id}/meta.json`)).json();
const BM_META = await (await fetch(`${ROOT}/assets/clips/basemaps/meta.json`)).json();

const $content = document.getElementById('content');
const $flash = document.getElementById('flash');
const $hex = document.getElementById('hexgrid');

// ---------------------------------------------------------------- helpers
const fr = (beat) => beat * FPB;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t) => {
  const c1 = 1.9, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const noise = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
};
/** Slam-in transform: big → settle with overshoot over `dur` frames, starting at beat b. */
function slam(f, b, { from = 2.2, dur = 6, rise = 0 } = {}) {
  const p = (f - fr(b)) / dur;
  if (p < 0) return null;
  const k = clamp(p);
  const s = lerp(from, 1, easeOutBack(k));
  const o = clamp(p * 3);
  const y = rise * (1 - easeOutCubic(k));
  return { s, o, y };
}
const tf = (st, extra = '') => (st ? `opacity:${st.o};transform:translateY(${st.y}px) scale(${st.s}) ${extra};` : 'display:none;');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function bigText(text, { y, size, cls = 'white', st, extra = '', spacing = 0 }) {
  return `<div class="big ${cls}" style="top:${y - size * 0.43}px;font-size:${size}px;letter-spacing:${spacing}em;${tf(st, extra)}">${esc(text)}</div>`;
}

// ---------------------------------------------------------------- global FX schedule
const FLASH = [[0, 0.7], [2, 0.9], [12, 1], [14, 0.35], [16, 0.3], [20, 0.3], [24, 0.3], [28, 0.3], [32, 0.3], [36, 0.3], [40, 0.3], [44, 0.3], [48, 0.8]];
const SHAKE = [[0, 18], [1, 10], [2, 34], [12, 46], [14, 16], [48, 22]];
const KICKS = (b) => (b < 8 || (b >= 12 && b < 52));

function globalFx(f) {
  let flash = 0;
  for (const [b, a] of FLASH) if (f >= fr(b)) flash = Math.max(flash, a * Math.exp(-(f - fr(b)) / 2.2));
  let sx = 0, sy = 0;
  for (const [b, amp] of SHAKE) {
    const d = f - fr(b);
    if (d >= 0 && d < 14) {
      const k = amp * Math.exp(-d / 3.5);
      sx += noise(f + b * 7) * k;
      sy += noise(f * 1.7 + b * 13) * k;
    }
  }
  const beat = f / FPB;
  const phase = beat - Math.floor(beat);
  const pulse = KICKS(Math.floor(beat)) ? Math.exp(-phase * 5) : 0;
  return { flash, sx, sy, hex: 0.22 + 0.45 * pulse, zoom: 1 + 0.012 * pulse };
}

// ---------------------------------------------------------------- sections
function hook(f) {
  const lines = [
    { b: 0, t: 'EVERY ROW', y: 700, size: 210, cls: 'white' },
    { b: 1, t: 'HAS A', y: 900, size: 210, cls: 'white' },
    { b: 2, t: 'PLACE.', y: 1150, size: 330, cls: 'red' },
  ];
  let h = lines.map((l) => bigText(l.t, { ...l, st: slam(f, l.b, { from: 2.6, dur: 5 }) })).join('');
  // pin drop + ripple on "PLACE."
  const d = f - fr(2);
  if (d >= 0) {
    const py = lerp(-200, 430, easeOutCubic(clamp(d / 6)));
    let rings = '';
    for (let k = 0; k < 3; k++) {
      const rd = d - 5 - k * 6;
      if (rd > 0) rings += `<circle cx="540" cy="455" r="${20 + rd * 9}" fill="none" stroke="#FF3621" stroke-width="5" opacity="${clamp(1 - rd / 26)}"/>`;
    }
    h += `<svg class="abs" style="left:0;top:0" width="1080" height="1920">${rings}
      <g transform="translate(540 ${py})"><path d="M0 0 C-60 -70 -60 -150 0 -150 C60 -150 60 -70 0 0Z" fill="#FF3621"/>
      <circle cx="0" cy="-100" r="22" fill="#0F1D22"/></g></svg>`;
  }
  return h;
}

const RAIN = [
  'POINT(-86.158 39.768)', 'POLYGON((-86.2 39.74,…))', '882661a213fffff', '{"type":"Point",…}',
  'districts.shp', '0101000000355EBA49…', 'GEOMETRY(4326)', 'LINESTRING(-86.07 39.875,…)',
  'roads.parquet', 'dp4dr2n6u7u2', 'SRID=4326;POINT(…)', 'MULTIPOLYGON(((…)))',
  'h3_kring(c, 4)', 'parcels.gpkg', 'lat 39.768 · lon -86.158', 'ST_GeomFromWKB(wkb)',
  '882661b545fffff', 'FeatureServer/0/query',
];
function rain(f, dim = 1) {
  return RAIN.map((txt, k) => {
    const sb = 4 + k * 0.22;
    const dt = (f - fr(sb)) / FPS;
    if (dt < 0) return '';
    const x = 40 + ((k * 263) % 760);
    const y = -120 + dt * (520 + (k % 5) * 90) + 0.5 * 1500 * dt * dt * 0.35;
    if (y > 2000) return '';
    const r = (noise(k) * 14) + dt * noise(k + 3) * 20;
    return `<div class="rain ${k % 4 === 0 ? 'hot' : ''}" style="left:${x}px;top:${y}px;opacity:${0.95 * dim};transform:rotate(${r}deg)">${esc(txt)}</div>`;
  }).join('');
}

function formats(f) {
  const words = ['POINTS.', 'POLYGONS.', 'SHAPEFILES.', 'H3 CELLS.'];
  const i = clamp(Math.floor(f / FPB) - 4, 0, 3);
  const b = 4 + i;
  return rain(f) + bigText(words[i], { y: 960, size: 220, cls: i % 2 ? 'red' : 'white', st: slam(f, b, { from: 1.8, dur: 4 }) });
}

function question(f) {
  const beat = f / FPB;
  const build = clamp((beat - 10) / 2);
  const jit = build * 10;
  const squeeze = beat > 11.5 ? lerp(1, 0.82, easeOutCubic(clamp((beat - 11.5) / 0.5))) : 1;
  const ex = `translateX(${noise(f) * jit}px) scaleY(${squeeze})`;
  return (
    rain(f, 0.3) +
    bigText('CAN YOUR SQL', { y: 830, size: 172, cls: 'white', st: slam(f, 8, { from: 1.6, dur: 5 }), extra: ex, spacing: build * 0.05 }) +
    bigText('DO GEOGRAPHY?', { y: 1010, size: 158, cls: 'red', st: slam(f, 10, { from: 1.6, dur: 5 }), extra: ex, spacing: build * 0.05 })
  );
}

function drop(f) {
  const beat = f / FPB;
  let h = '';
  if (beat < 13) {
    h += `<div class="abs" style="inset:0;background:#FF3621"></div>`;
    h += bigText('NOW', { y: 820, size: 320, cls: 'ink', st: slam(f, 12, { from: 3, dur: 5 }) });
    h += bigText('IT CAN.', { y: 1100, size: 250, cls: 'ink', st: slam(f, 12.25, { from: 3, dur: 5 }) });
    return h;
  }
  const k = easeOutCubic(clamp((f - fr(13)) / 6));
  h += bigText('NOW IT CAN.', { y: lerp(940, 420, k), size: lerp(260, 130, k), cls: 'white', st: { s: 1, o: 1, y: 0 } });
  const logo = slam(f, 14, { from: 2.4, dur: 6 });
  if (logo)
    h += `<svg class="abs" style="left:440px;top:560px;${tf(logo)}" width="200" height="200" viewBox="0 0 32 32">
      <path d="M16 3 28 10v12L16 29 4 22V10z" fill="none" stroke="#fff" stroke-width="2.2"/><circle cx="16" cy="16" r="3.6" fill="#FF3621"/></svg>`;
  h += bigText('SPATIAL SQL', { y: 900, size: 200, cls: 'white', st: slam(f, 14, { from: 2, dur: 5 }) });
  h += bigText('ON DATABRICKS', { y: 1065, size: 132, cls: 'red', st: slam(f, 14.5, { from: 2, dur: 5 }) });
  const chips = [
    ['90+ ST_ FUNCTIONS', 15],
    ['H3 INDEXING', 15.33],
    ['NATIVE GEOMETRY TYPES', 15.66],
  ];
  chips.forEach(([t, b], i) => {
    const st = slam(f, b, { from: 1.7, dur: 4 });
    h += `<div class="chip" style="left:50%;top:${1250 + i * 100}px;margin-left:-${t.length * 9.6 + 22}px;${tf(st)}">${t}</div>`;
  });
  return h;
}

// ------------------------------------------------ app footage cards
const MAP_CARD = { x: 60, y: 460, w: 960, h: 790 };
const LOW_CARD = { x: 60, y: 1285, w: 960, h: 400 };

function mapCard(src, map, focus, zoom, caption, punch, attribution = true) {
  const a = MAP_CARD.w / MAP_CARD.h;
  const cw = map.w / zoom;
  const ch = cw / a;
  const cx = clamp(focus[0], map.x + cw / 2, map.x + map.w - cw / 2);
  const cy = clamp(focus[1], map.y + ch / 2, map.y + map.h - ch / 2);
  const s = MAP_CARD.w / cw;
  const left = -(cx - cw / 2) * s;
  const top = -(cy - ch / 2) * s;
  return `<div class="card" style="left:${MAP_CARD.x}px;top:${MAP_CARD.y}px;width:${MAP_CARD.w}px;height:${MAP_CARD.h}px;transform:scale(${punch})">
    <img src="${src}" style="left:${left}px;top:${top}px;width:${1440 * s}px;height:${900 * s}px"/>
    ${caption ? `<div class="cap">${esc(caption)}</div>` : ''}
    ${attribution ? '<div class="attrib">Map tiles © CARTO, © OpenStreetMap contributors</div>' : ''}
  </div>`;
}

function cropCard(src, r, label, mode) {
  const inner = { w: LOW_CARD.w, h: LOW_CARD.h - 52 };
  const s = mode === 'fit' ? Math.min(inner.w / r.w, inner.h / r.h) : inner.w / r.w;
  const ox = (inner.w - r.w * s) / 2;
  return `<div class="card" style="left:${LOW_CARD.x}px;top:${LOW_CARD.y}px;width:${LOW_CARD.w}px;height:${LOW_CARD.h}px">
    <div class="abs" style="left:0;top:52px;width:${inner.w}px;height:${inner.h}px;overflow:hidden;background:${mode === 'fit' ? '#13222E' : '#fff'}">
      <div class="abs" style="left:${ox}px;top:${mode === 'fit' ? (inner.h - r.h * s) / 2 : 0}px;width:${r.w * s}px;height:${Math.min(inner.h, r.h * s)}px;overflow:hidden;border-radius:${mode === 'fit' ? 10 : 0}px">
        <img src="${src}" style="position:absolute;left:${-r.x * s}px;top:${-r.y * s}px;width:${1440 * s}px;height:${900 * s}px"/>
      </div>
    </div>
    <div class="tab">${label}</div>
  </div>`;
}

const ZOOMS = [1.0, 1.1, 1.2, 1.32];
function zoomAt(f, startBeat) {
  const local = (f - fr(startBeat)) / FPB;
  const i = clamp(Math.floor(local), 0, 3);
  const prev = ZOOMS[Math.max(0, i - 1)];
  const k = easeOutCubic(clamp((local - i) * FPB / 3));
  return lerp(prev, ZOOMS[i], i === 0 ? 1 : k);
}
const punchAt = (f, b) => 1 + 0.05 * Math.exp(-Math.max(0, f - fr(b)) / 2.5);

function headline(f, b, verb, sub) {
  return (
    bigText(verb, { y: 270, size: 180, cls: 'white', st: slam(f, b, { from: 1.9, dur: 4 }) }) +
    `<div class="chip" style="left:50%;top:375px;transform:translateX(-50%) scale(${(slam(f, b + 0.25, { from: 1.4, dur: 4 }) ?? { s: 1 }).s});opacity:${(slam(f, b + 0.25) ?? { o: 0 }).o}">${esc(sub)}</div>`
  );
}

function clips(f) {
  const beat = f / FPB;
  const clip = [...TL.clips].reverse().find((c) => beat >= c.beat);
  const meta = META[clip.id];
  const idx = clamp(Math.round(f - fr(clip.beat)), 0, meta.frames.length - 1);
  const frame = meta.frames[idx];
  const src = `${ROOT}/assets/clips/${clip.id}/${frame.file}`;
  const localBeat = Math.floor(beat - clip.beat);
  let h = headline(f, clip.beat, clip.verb, clip.fns);
  h += mapCard(src, meta.map, clip.focus, zoomAt(f, clip.beat), frame.caption, punchAt(f, clip.beat));
  h +=
    localBeat < 2
      ? cropCard(src, meta.sql, '<b>●</b> Databricks SQL · the live clause lights up', 'fit')
      : cropCard(src, meta.table, '<b>●</b> Result · fills in as the query runs', 'top');
  return h;
}

function basemaps(f) {
  const bm = TL.basemaps;
  const beat = f / FPB;
  const k = clamp(Math.floor(beat - bm.beat), 0, 3);
  const id = bm.order[k];
  let h = headline(f, bm.beat, 'ANY BASEMAP.', 'same layers · any tiles');
  const attribution = id !== 'esri';
  h += mapCard(`${ROOT}/assets/clips/basemaps/${id}.jpg`, BM_META.map, [600, 450], 1.12 + 0.04 * k, '', punchAt(f, bm.beat + k), attribution);
  if (!attribution) h += `<div class="abs" style="left:${MAP_CARD.x + 20}px;top:${MAP_CARD.y + MAP_CARD.h - 40}px;font-size:16px;color:rgba(255,255,255,.75)">Imagery © Esri, Maxar, Earthstar Geographics</div>`;
  const rows = bm.labels
    .map((l, i) => {
      const on = i === k;
      return `<div style="display:flex;align-items:center;gap:18px;height:74px;font-family:'Barlow Condensed';font-weight:800;font-size:52px;text-transform:uppercase;color:${on ? '#fff' : '#557080'}">
        <span style="width:22px;height:22px;border-radius:50%;background:${on ? '#FF3621' : '#2C4A55'}"></span>${esc(l)}</div>`;
    })
    .join('');
  h += `<div class="card" style="left:${LOW_CARD.x}px;top:${LOW_CARD.y}px;width:${LOW_CARD.w}px;height:${LOW_CARD.h}px;padding:44px 50px">${rows}</div>`;
  return h;
}

const TOOLS = ['ArcGIS', 'QGIS', 'Power BI', 'Tableau', 'GeoPandas', 'Kepler.gl', 'PostGIS', 'GeoParquet'];
function ecosystem(f) {
  const beat = f / FPB;
  const k = clamp(Math.floor(beat - 40), 0, 3);
  const words = ['ARCGIS.', 'QGIS.', 'POWER BI.', 'TABLEAU.'];
  let h = bigText(words[k], { y: 300, size: 190, cls: k % 2 ? 'red' : 'white', st: slam(f, 40 + k, { from: 1.9, dur: 4 }) });
  const cx = 540, cy = 1080, R = 360;
  let lines = '';
  let tools = '';
  TOOLS.forEach((t, i) => {
    const ang = -Math.PI / 2 + (i / TOOLS.length) * Math.PI * 2;
    const x = cx + Math.cos(ang) * R * 0.98, y = cy + Math.sin(ang) * R;
    const appear = clamp((f - fr(40) - i * 1.5) / 5);
    const hot = i === k, lit = i < k || i >= 4;
    const pk = ((f / 18 + i * 0.37) % 1);
    lines += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${hot ? '#FF3621' : '#2C4A55'}" stroke-width="${hot ? 5 : 3}" opacity="${appear}"/>
      <circle cx="${lerp(cx, x, pk)}" cy="${lerp(cy, y, pk)}" r="${hot ? 9 : 6}" fill="${hot ? '#FF3621' : '#8CC4CF'}" opacity="${appear}"/>`;
    tools += `<div class="tool ${hot ? 'hot' : lit ? 'lit' : ''}" style="left:${x}px;top:${y}px;opacity:${appear};transform:translate(-50%,-50%) scale(${hot ? 1.12 : 1})">${t}</div>`;
  });
  const hub = slam(f, 40, { from: 1.6, dur: 6 });
  h += `<svg class="abs" style="left:0;top:0" width="1080" height="1920">${lines}
    <g style="transform-origin:${cx}px ${cy}px;${tf(hub)}"><path d="M${cx} ${cy - 210} L${cx + 182} ${cy - 105} L${cx + 182} ${cy + 105} L${cx} ${cy + 210} L${cx - 182} ${cy + 105} L${cx - 182} ${cy - 105}Z" fill="#13222E" stroke="#FF3621" stroke-width="5"/></g></svg>`;
  h += `<div class="abs" style="left:0;right:0;top:${cy - 70}px;text-align:center;${tf(hub)}">
      <div style="font-family:'Barlow Condensed';font-weight:900;font-size:76px">DATABRICKS</div>
      <div style="font-size:31px;color:#8CC4CF;font-weight:600;margin-top:6px">Delta · Spatial SQL · H3<br/>Unity Catalog</div></div>`;
  h += tools;
  return h;
}

const QUERIES = ['00_transform_32616', '01_st_point', '02_area', '03_buffer', '04_join', '05_nearest', '06_dwithin', '07_overlay', '08_simplify',
  '09_h3_agg', '10_kring', '11_formats_point', '11b_formats_polygon', '12_gold_select', '13_kepler', '14_bi_view_select', '15_genie', '16_bi_hex_centers'];
function verify(f) {
  let h = bigText('TESTED ON A', { y: 260, size: 150, cls: 'white', st: slam(f, 44, { from: 1.9, dur: 4 }) });
  h += bigText('REAL WAREHOUSE.', { y: 400, size: 150, cls: 'red', st: slam(f, 44.5, { from: 1.9, dur: 4 }) });
  const n = clamp(Math.floor((f - fr(44.5)) / 2.6), 0, QUERIES.length);
  const rows = QUERIES.slice(0, n)
    .slice(-14)
    .map((q) => `<div><span class="ok">✓</span> ${q.padEnd(22, ' ').replace(/ /g, '&nbsp;')}<span class="ok">SUCCEEDED</span></div>`)
    .join('');
  h += `<div class="card term" style="left:60px;top:520px;width:960px;height:1160px;padding:34px 40px">
    <div class="dim" style="font-size:24px;margin-bottom:18px">$ databricks experimental aitools tools query --file sql/*.sql</div>${rows}
    <div style="position:absolute;right:40px;bottom:26px;font-family:'Barlow Condensed';font-weight:900;font-size:120px;color:${n === QUERIES.length ? '#FF3621' : '#fff'}">${n}/${QUERIES.length}</div>
  </div>`;
  return h;
}

function endCard(f) {
  let h = '';
  const logo = slam(f, 48, { from: 3, dur: 6 });
  if (logo)
    h += `<svg class="abs" style="left:420px;top:300px;${tf(logo)}" width="240" height="240" viewBox="0 0 32 32">
      <path d="M16 3 28 10v12L16 29 4 22V10z" fill="none" stroke="#fff" stroke-width="2.2"/><circle cx="16" cy="16" r="3.6" fill="#FF3621"/></svg>`;
  h += bigText('SPATIAL SQL', { y: 700, size: 200, cls: 'white', st: slam(f, 48.5, { from: 2, dur: 5 }) });
  h += bigText('ON DATABRICKS', { y: 860, size: 132, cls: 'red', st: slam(f, 48.75, { from: 2, dur: 5 }) });
  const sub = slam(f, 49.5, { from: 1, dur: 6, rise: 30 });
  h += `<div class="abs" style="left:0;right:0;top:960px;text-align:center;font-size:46px;font-weight:600;${tf(sub)}">An interactive field guide in 12 steps</div>`;
  const url = slam(f, 50.5, { from: 1.6, dur: 5 });
  h += `<div class="pill" style="left:50%;top:1080px;background:#FF3621;color:#13222E;font-size:62px;transform:translateX(-50%) scale(${url?.s ?? 1});opacity:${url?.o ?? 0}">ashrafosman.github.io/dbxgis</div>`;
  const free = slam(f, 51.5, { from: 1, dur: 6, rise: 24 });
  h += `<div class="abs teal" style="left:0;right:0;top:1230px;text-align:center;font-size:40px;font-weight:600;${tf(free)}">Free · no sign-up · runs in your browser</div>`;
  const by = slam(f, 52.5, { from: 1, dur: 8, rise: 20 });
  h += `<div class="abs" style="left:0;right:0;top:1520px;text-align:center;${tf(by)}">
      <div style="font-size:38px;font-weight:700">Ashraf Osman, PhD</div>
      <div style="font-size:30px;color:#8CC4CF;margin-top:6px">linkedin.com/in/ashraf-osman-phd</div>
      <div style="font-size:24px;color:#6F8798;margin-top:26px">Independent demo · not an official Databricks site · synthetic data</div>
    </div>`;
  return h;
}

const SECTIONS = [
  [0, hook], [4, formats], [8, question], [12, drop], [16, clips], [36, basemaps], [40, ecosystem], [44, verify], [48, endCard],
];

window.renderFrame = async (f) => {
  const beat = f / FPB;
  const [, fn] = [...SECTIONS].reverse().find(([b]) => beat >= b);
  const fx = globalFx(f);
  $content.innerHTML = fn(f);
  $content.style.transform = `translate(${fx.sx}px, ${fx.sy}px) scale(${fx.zoom})`;
  $flash.style.opacity = fx.flash;
  $hex.style.opacity = fx.hex;
  await Promise.all([...$content.querySelectorAll('img')].map((im) => im.decode().catch(() => {})));
};
window.TOTAL_FRAMES = TOTAL_FRAMES;
window.compositorReady = document.fonts.ready.then(() => true);
