import * as turf from '@turf/turf';
import type { Feature, FeatureCollection, LineString, MultiPolygon, Point, Polygon } from 'geojson';

// Fabricated EMS / public-health dataset around Indianapolis, IN.
// Deterministic (seeded) so every demo run looks the same.

export const CENTER: [number, number] = [-86.158, 39.768];
export const BBOX: [number, number, number, number] = [-86.34, 39.63, -85.97, 39.91];

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261117);
const gauss = () => {
  let u = 0;
  let v = 0;
  while (!u) u = rand();
  while (!v) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// ---------------------------------------------------------------- county boundary
// A detailed, wobbly boundary (720 vertices) — useful for ST_Simplify.
function makeCounty(): Feature<Polygon, { name: string }> {
  const ring: [number, number][] = [];
  const N = 720;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const wobble =
      1 +
      0.06 * Math.sin(a * 3 + 0.4) +
      0.035 * Math.sin(a * 7 + 1.3) +
      0.018 * Math.sin(a * 17) +
      0.008 * Math.sin(a * 41 + 2) +
      0.004 * (rand() - 0.5);
    const rx = 0.158 * wobble;
    const ry = 0.112 * wobble;
    ring.push([CENTER[0] + Math.cos(a) * rx, CENTER[1] + Math.sin(a) * ry]);
  }
  ring.push(ring[0]);
  return turf.polygon([ring], { name: 'Marion County (synthetic)' });
}
export const county = makeCounty();

// ---------------------------------------------------------------- river
function makeRiver(): Feature<LineString, { name: string }> {
  const base = turf.lineString([
    [-86.02, 39.93],
    [-86.07, 39.875],
    [-86.115, 39.835],
    [-86.16, 39.805],
    [-86.178, 39.775],
    [-86.185, 39.745],
    [-86.205, 39.71],
    [-86.24, 39.665],
    [-86.29, 39.61],
  ]);
  const len = turf.length(base, { units: 'kilometers' });
  const N = 520;
  const coords: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const p = turf.along(base, (len * i) / N, { units: 'kilometers' }).geometry.coordinates;
    const off = Math.sin(i * 0.19) * 0.0035 + Math.sin(i * 0.051) * 0.006 + Math.sin(i * 0.6) * 0.0006;
    coords.push([p[0] + off, p[1] + off * 0.35]);
  }
  return turf.lineString(coords, { name: 'White River' });
}
export const river = makeRiver();

// ---------------------------------------------------------------- districts
// Seeds sit near the real neighbourhoods so names read correctly to a local audience.
const DISTRICT_SEEDS: [string, number, number][] = [
  ['Mile Square', -86.157, 39.768],
  ['Fountain Square', -86.135, 39.742],
  ['Broad Ripple', -86.14, 39.862],
  ['Nora', -86.175, 39.878],
  ['Glendale', -86.095, 39.848],
  ['Lawrence', -86.025, 39.84],
  ['Irvington', -86.065, 39.775],
  ['Haughville', -86.215, 39.772],
  ['Speedway', -86.255, 39.805],
  ['Eagle Creek', -86.285, 39.845],
  ['Mars Hill', -86.245, 39.715],
  ['Southport', -86.13, 39.668],
  ['Beech Grove', -86.088, 39.715],
  ['Franklin Twp', -86.03, 39.69],
  ['Butler-Tarkington', -86.175, 39.83],
];

export type DistrictProps = { key: string; id: number; name: string };
function makeDistricts(): Feature<Polygon | MultiPolygon, DistrictProps>[] {
  const seeds = DISTRICT_SEEDS.map(([name, x, y]) => turf.point([x, y], { name }));
  const vor = turf.voronoi(turf.featureCollection(seeds), { bbox: BBOX });
  const out: Feature<Polygon | MultiPolygon, DistrictProps>[] = [];
  vor.features.forEach((cell, i) => {
    if (!cell) return;
    const clipped = turf.intersect(turf.featureCollection([cell, county]));
    if (!clipped) return;
    out.push({
      type: 'Feature',
      geometry: clipped.geometry,
      properties: { key: `district-${i}`, id: i, name: DISTRICT_SEEDS[i][0] },
    });
  });
  return out;
}
export const districts = makeDistricts();

// ---------------------------------------------------------------- clinics
export type ClinicProps = { key: string; id: number; name: string };
const CLINIC_SPOTS: [string, number, number][] = [
  ['Downtown Health Center', -86.157, 39.771],
  ['Eastside Clinic', -86.05, 39.775],
  ['Northside Urgent Care', -86.14, 39.87],
  ['Westside Community Health', -86.265, 39.775],
  ['Southport Medical', -86.13, 39.665],
  ['Riverside Clinic', -86.182, 39.758],
  ['Lawrence Family Care', -86.02, 39.845],
  ['Speedway Health Hub', -86.245, 39.80],
  ['Beech Grove Wellness', -86.085, 39.715],
];
export const clinics: Feature<Point, ClinicProps>[] = CLINIC_SPOTS.map(([name, x, y], i) =>
  turf.point([x, y], { key: `clinic-${i}`, id: i, name }),
);

// ---------------------------------------------------------------- incidents
export type IncidentProps = { key: string; id: string; type: string; lon: number; lat: number };
const TYPES: [string, number][] = [
  ['Fall', 0.3],
  ['Cardiac', 0.2],
  ['Respiratory', 0.22],
  ['Overdose', 0.16],
  ['Heat illness', 0.12],
];
const pickType = () => {
  let r = rand();
  for (const [t, w] of TYPES) {
    if ((r -= w) <= 0) return t;
  }
  return TYPES[0][0];
};
const HOTSPOTS: [number, number, number, number][] = [
  // lon, lat, sigma(deg), weight
  [-86.158, 39.768, 0.016, 0.3],
  [-86.11, 39.80, 0.012, 0.15],
  [-86.22, 39.755, 0.014, 0.15],
  [-86.12, 39.70, 0.013, 0.12],
  [-86.06, 39.845, 0.015, 0.1],
];
function makeIncidents(n: number): FeatureCollection<Point, IncidentProps> {
  const feats: Feature<Point, IncidentProps>[] = [];
  const bb = turf.bbox(county);
  let i = 0;
  while (feats.length < n) {
    let x: number;
    let y: number;
    const r = rand();
    let acc = 0;
    const hs = HOTSPOTS.find((h) => (acc += h[3]) >= r);
    if (hs) {
      x = hs[0] + gauss() * hs[2] * 1.3;
      y = hs[1] + gauss() * hs[2];
    } else {
      x = bb[0] + rand() * (bb[2] - bb[0]);
      y = bb[1] + rand() * (bb[3] - bb[1]);
    }
    const p: [number, number] = [x, y];
    if (!turf.booleanPointInPolygon(p, county)) continue;
    i++;
    const id = `INC-${String(10000 + i)}`;
    feats.push(
      turf.point(p, { key: id, id, type: pickType(), lon: +x.toFixed(5), lat: +y.toFixed(5) }),
    );
  }
  return turf.featureCollection(feats);
}
export const incidents = makeIncidents(650);
