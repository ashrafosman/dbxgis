import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';

export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
/** progress of t inside [a, b] mapped to 0..1 */
export const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
export const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
export const feat = (geometry: Geometry, properties: Record<string, unknown> = {}): Feature => ({
  type: 'Feature',
  geometry,
  properties,
});

// ------------------------------------------------------------------ WKT
const n = (v: number) => +v.toFixed(6);
const pos = (p: Position) => `${n(p[0])} ${n(p[1])}`;
// Databricks ST_AsText separates coordinates with ',' (no space)
const ring = (r: Position[]) => `(${r.map(pos).join(',')})`;

export function toWKT(g: Geometry): string {
  switch (g.type) {
    case 'Point':
      return `POINT(${pos(g.coordinates)})`;
    case 'LineString':
      return `LINESTRING${ring(g.coordinates)}`;
    case 'Polygon':
      return `POLYGON(${g.coordinates.map(ring).join(',')})`;
    case 'MultiPolygon':
      return `MULTIPOLYGON(${g.coordinates.map((p) => `(${p.map(ring).join(',')})`).join(',')})`;
    case 'MultiLineString':
      return `MULTILINESTRING(${g.coordinates.map(ring).join(',')})`;
    default:
      return g.type.toUpperCase();
  }
}

export const shortWKT = (g: Geometry, max = 46) => {
  const s = toWKT(g);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
};

// ------------------------------------------------------------------ WKB (little-endian, hex)
export function toWKBHex(g: Geometry): string {
  const bytes: number[] = [];
  const dv = new DataView(new ArrayBuffer(8));
  const u8 = (v: number) => bytes.push(v);
  const u32 = (v: number) => {
    dv.setUint32(0, v, true);
    for (let i = 0; i < 4; i++) u8(dv.getUint8(i));
  };
  const f64 = (v: number) => {
    dv.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) u8(dv.getUint8(i));
  };
  const pts = (ps: Position[]) => {
    u32(ps.length);
    ps.forEach((p) => {
      f64(p[0]);
      f64(p[1]);
    });
  };
  const write = (geom: Geometry) => {
    u8(1);
    switch (geom.type) {
      case 'Point':
        u32(1);
        f64(geom.coordinates[0]);
        f64(geom.coordinates[1]);
        break;
      case 'LineString':
        u32(2);
        pts(geom.coordinates);
        break;
      case 'Polygon':
        u32(3);
        u32(geom.coordinates.length);
        geom.coordinates.forEach(pts);
        break;
      case 'MultiPolygon':
        u32(6);
        u32(geom.coordinates.length);
        geom.coordinates.forEach((p) => write({ type: 'Polygon', coordinates: p }));
        break;
      default:
        throw new Error(`WKB not implemented for ${geom.type}`);
    }
  };
  write(g);
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// ------------------------------------------------------------------ geohash
const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';
export function geohash(lon: number, lat: number, precision = 9): string {
  let latR = [-90, 90];
  let lonR = [-180, 180];
  let hash = '';
  let bit = 0;
  let ch = 0;
  let even = true;
  while (hash.length < precision) {
    const r = even ? lonR : latR;
    const v = even ? lon : lat;
    const mid = (r[0] + r[1]) / 2;
    if (v >= mid) {
      ch |= 1 << (4 - bit);
      r[0] = mid;
    } else r[1] = mid;
    if (even) lonR = r;
    else latR = r;
    even = !even;
    if (bit < 4) bit++;
    else {
      hash += B32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

export function countVertices(g: Geometry): number {
  switch (g.type) {
    case 'Point':
      return 1;
    case 'LineString':
      return g.coordinates.length;
    case 'Polygon':
      return g.coordinates.reduce((s, r) => s + r.length, 0);
    case 'MultiPolygon':
      return g.coordinates.reduce((s, p) => s + p.reduce((q, r) => q + r.length, 0), 0);
    default:
      return 0;
  }
}

export const fmt = (v: number, digits = 2) =>
  v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
