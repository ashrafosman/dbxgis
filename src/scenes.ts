import * as turf from '@turf/turf';
import { POLYGON_TO_CELLS_FLAGS, cellToBoundary, gridDisk, gridDistance, latLngToCell, polygonToCells, polygonToCellsExperimental } from 'h3-js';
import type { Feature, FeatureCollection, Geometry, LineString, Point, Polygon, MultiPolygon } from 'geojson';
import { CENTER, clinics, county, districts, incidents, river } from './data';
import { countVertices, ease, fc, feat, fmt, geohash, lerp, seg, shortWKT, toWKBHex, toWKT } from './geo';

// ---------------------------------------------------------------- palette (mirrors styles.css)
export const C = {
  ink: '#13222E',
  red: '#FF3621',
  teal: '#1F7A8C',
  tealLight: '#8CC4CF',
  amber: '#F2A900',
  slate: '#8A9AA6',
  paper: '#F7F9FA',
};

// ---------------------------------------------------------------- types
export type Row = { key: string; cells: Record<string, string | number>; geom?: Geometry };
export type LayerDef = {
  id: string;
  source: string;
  type: 'circle' | 'fill' | 'line' | 'fill-extrusion';
  paint: Record<string, unknown>;
  layout?: Record<string, unknown>;
  filter?: unknown[];
};
export type Stage = { at: number; caption: string };
export type Clause = { text: string; stage: number };
export type Camera = { center?: [number, number]; zoom?: number; pitch?: number; bearing?: number };
export type Output = {
  layers: LayerDef[];
  frame: (t: number) => Record<string, FeatureCollection>;
  columns: string[];
  rows: (t: number) => Row[];
  stages: Stage[];
  stats?: (t: number) => { label: string; value: string }[];
  custom?: 'ecosystem';
};
export type Param = { key: string; label: string; min: number; max: number; step: number; value: number; unit: string };
export type Ctx = { probe: [number, number]; selected: string };
export type Scene = {
  id: string;
  group: string;
  title: string;
  fns: string[];
  blurb: string;
  params: Param[];
  interaction?: 'probe' | 'select';
  hint?: string;
  camera: Camera;
  duration: number;
  sql: (p: Record<string, number>, ctx: Ctx) => Clause[];
  build: (p: Record<string, number>, ctx: Ctx) => Output;
};

const HOME: Camera = { center: CENTER, zoom: 10.4, pitch: 0, bearing: 0 };
const pts = incidents.features;
const km2 = (g: Feature | Geometry) => turf.area(g as Feature) / 1e6;

const districtOutline: LayerDef = {
  id: 'districts-outline',
  source: 'districts',
  type: 'line',
  paint: { 'line-color': C.ink, 'line-width': 1, 'line-opacity': 0.35 },
};
const clinicLayer = (source = 'clinics'): LayerDef => ({
  id: `${source}-pt`,
  source,
  type: 'circle',
  paint: {
    'circle-radius': ['coalesce', ['get', 'r'], 7],
    'circle-color': ['coalesce', ['get', 'color'], C.ink],
    'circle-stroke-color': '#fff',
    'circle-stroke-width': 2,
  },
});
const allDistricts = fc(districts as Feature[]);

function perimeterKm(g: Polygon | MultiPolygon) {
  const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
  return rings.reduce((s, r) => s + turf.length(turf.lineString(r), { units: 'kilometers' }), 0);
}

// ================================================================= scenes
const sPoint: Scene = {
  id: 'st-point',
  group: 'Build geometry',
  title: 'Turn coordinates into geometry',
  fns: ['ST_Point', 'GEOMETRY(4326)'],
  blurb:
    'Most spatial data lands as plain numbers — a longitude and a latitude in a CSV or a Kafka message. ST_Point turns each pair into a native GEOMETRY value that Delta stores, indexes and governs like any other column.',
  params: [],
  camera: HOME,
  duration: 5200,
  sql: () => [
    { text: 'CREATE TABLE ems.silver.incidents AS', stage: 2 },
    { text: 'SELECT incident_id, type, lon, lat,', stage: 0 },
    { text: '       ST_Point(lon, lat, 4326) AS geom', stage: 1 },
    { text: 'FROM   ems.raw.incidents_csv;', stage: 0 },
  ],
  build: () => {
    const N = 30;
    return {
      stages: [
        { at: 0, caption: `Reading ${pts.length} raw rows of longitude / latitude` },
        { at: 0.15, caption: 'ST_Point builds a GEOMETRY for every row (SRID 4326 = WGS 84)' },
        { at: 0.93, caption: `${pts.length} points written to a Delta table with a GEOMETRY(4326) column` },
      ],
      layers: [
        {
          id: 'inc',
          source: 'inc',
          type: 'circle',
          paint: {
            'circle-radius': ['+', 2.6, ['*', 6, ['get', 'f']]],
            'circle-color': ['interpolate', ['linear'], ['get', 'f'], 0, C.teal, 1, C.red],
            'circle-opacity': 0.85,
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 0.6,
          },
        },
      ],
      frame: (t) => {
        const n = Math.floor(seg(t, 0.15, 0.93) * pts.length);
        return {
          inc: fc(
            pts.slice(0, n).map((f, i) => feat(f.geometry, { key: f.properties.id, f: Math.max(0, 1 - (n - i) / 40) })),
          ),
        };
      },
      columns: ['incident_id', 'lon', 'lat', 'geom'],
      rows: (t) => {
        const shown = Math.floor(seg(t, 0.15, 0.6) * N);
        return pts.slice(0, N).map((f, i) => ({
          key: f.properties.id,
          geom: f.geometry,
          cells: {
            incident_id: f.properties.id,
            lon: f.properties.lon,
            lat: f.properties.lat,
            geom: i < shown ? shortWKT(f.geometry) : '·',
          },
        }));
      },
    };
  },
};

const sPolygons: Scene = {
  id: 'st-area',
  group: 'Build geometry',
  title: 'Load polygons and measure them',
  fns: ['ST_GeomFromGeoJSON', 'ST_Transform', 'ST_Area', 'ST_Perimeter'],
  blurb:
    'Boundaries arrive as GeoJSON, WKT, WKB or shapefiles. Parse them once into GEOMETRY, then measure. Degrees are not metres, so we project to UTM zone 16N (EPSG:32616) with ST_Transform before calling ST_Area.',
  params: [],
  camera: HOME,
  duration: 5200,
  sql: () => [
    { text: 'SELECT name,', stage: 0 },
    { text: '  ST_GeomFromGeoJSON(geojson)            AS geom,', stage: 0 },
    { text: '  ST_Transform(geom, 32616)              AS geom_utm,', stage: 1 },
    { text: '  ST_Area(geom_utm) / 1e6                AS area_km2,', stage: 2 },
    { text: '  ST_Perimeter(geom_utm) / 1e3           AS perimeter_km', stage: 2 },
    { text: 'FROM ems.ref.districts_geojson;', stage: 0 },
  ],
  build: () => {
    const meta = districts.map((d) => ({ d, area: km2(d), per: perimeterKm(d.geometry) }));
    const maxA = Math.max(...meta.map((m) => m.area));
    const appear = (i: number) => 0.05 + (i / meta.length) * 0.45;
    return {
      stages: [
        { at: 0, caption: 'ST_GeomFromGeoJSON parses each boundary into a GEOMETRY' },
        { at: 0.5, caption: 'ST_Transform reprojects from degrees (4326) to metres (UTM 16N)' },
        { at: 0.68, caption: 'ST_Area / ST_Perimeter measure each district — darker = larger' },
      ],
      layers: [
        {
          id: 'd-fill',
          source: 'd',
          type: 'fill',
          paint: { 'fill-color': C.teal, 'fill-opacity': ['get', 'fo'] },
        },
        {
          id: 'd-line',
          source: 'd',
          type: 'line',
          paint: { 'line-color': C.ink, 'line-width': ['get', 'lw'], 'line-opacity': ['get', 'lo'] },
        },
      ],
      frame: (t) => {
        const fill = seg(t, 0.68, 0.95);
        return {
          d: fc(
            meta
              .filter((_, i) => t >= appear(i))
              .map((m, i) => {
                const fresh = 1 - seg(t, appear(i), appear(i) + 0.12);
                return feat(m.d.geometry, {
                  key: m.d.properties.key,
                  lw: 1 + 2.5 * fresh,
                  lo: 0.4 + 0.6 * fresh,
                  fo: 0.08 * fresh + fill * (0.1 + 0.6 * (m.area / maxA)),
                });
              }),
          ),
        };
      },
      columns: ['name', 'geom', 'area_km2', 'perimeter_km'],
      rows: (t) =>
        meta
          .filter((_, i) => t >= appear(i))
          .map((m) => ({
            key: m.d.properties.key,
            geom: m.d.geometry,
            cells: {
              name: m.d.properties.name,
              geom: shortWKT(m.d.geometry, 30),
              area_km2: t >= 0.68 ? fmt(m.area, 1) : '·',
              perimeter_km: t >= 0.68 ? fmt(m.per, 1) : '·',
            },
          })),
      stats: (t) =>
        t < 0.68 ? [] : [{ label: 'Total area', value: `${fmt(meta.reduce((s, m) => s + m.area, 0), 0)} km²` }],
    };
  },
};

const sBuffer: Scene = {
  id: 'st-buffer',
  group: 'Measure and relate',
  title: 'Draw service areas with a buffer',
  fns: ['ST_Buffer', 'ST_Contains', 'ST_Area'],
  blurb:
    'ST_Buffer grows a geometry outward by a distance. Around each clinic that gives a service area; ST_Contains then counts the incidents that fall inside it. Drag the radius and watch coverage change.',
  params: [{ key: 'r', label: 'Buffer radius', min: 250, max: 4000, step: 50, value: 1500, unit: 'm' }],
  camera: HOME,
  duration: 5000,
  sql: (p) => [
    { text: 'WITH zones AS (', stage: 0 },
    { text: '  SELECT name,', stage: 0 },
    { text: `    ST_Buffer(ST_Transform(geom, 32616), ${p.r}) AS zone,`, stage: 0 },
    { text: '    ST_Area(zone) / 1e6                  AS zone_km2', stage: 0 },
    { text: '  FROM ems.ref.clinics)', stage: 0 },
    { text: 'SELECT z.name, z.zone_km2,', stage: 1 },
    { text: '       COUNT(i.incident_id)      AS incidents_within', stage: 1 },
    { text: 'FROM zones z LEFT JOIN ems.silver.incidents i', stage: 1 },
    { text: '  ON ST_Contains(z.zone, ST_Transform(i.geom, 32616))', stage: 1 },
    { text: '-- GEOMETRY is not groupable: group by scalar columns only', stage: 2 },
    { text: 'GROUP BY z.name, z.zone_km2 ORDER BY incidents_within DESC;', stage: 2 },
  ],
  build: (p) => {
    const r = p.r;
    const covering = pts.map((f) => clinics.filter((c) => turf.distance(c, f, { units: 'meters' }) <= r).map((c) => c.properties.id));
    const counts = clinics.map((c) => covering.filter((cv) => cv.includes(c.properties.id)).length);
    const covered = covering.filter((cv) => cv.length > 0).length;
    const fullZones = clinics.map((c) => turf.circle(c, r, { units: 'meters', steps: 72 }));
    return {
      stages: [
        { at: 0, caption: `ST_Buffer grows each clinic into a ${fmt(r, 0)} m service area` },
        { at: 0.62, caption: 'ST_Contains tests every incident against every zone' },
        { at: 0.95, caption: `${covered} of ${pts.length} incidents (${fmt((covered / pts.length) * 100, 0)}%) are inside a service area` },
      ],
      layers: [
        districtOutline,
        { id: 'z-fill', source: 'z', type: 'fill', paint: { 'fill-color': C.teal, 'fill-opacity': 0.16 } },
        { id: 'z-line', source: 'z', type: 'line', paint: { 'line-color': C.teal, 'line-width': 2 } },
        {
          id: 'inc',
          source: 'inc',
          type: 'circle',
          paint: {
            'circle-radius': ['+', 2.2, ['*', 2, ['get', 'c']]],
            'circle-color': ['interpolate', ['linear'], ['get', 'c'], 0, C.slate, 1, C.red],
            'circle-opacity': 0.8,
          },
        },
        clinicLayer(),
      ],
      frame: (t) => {
        const rr = r * ease(seg(t, 0.05, 0.6));
        const c = seg(t, 0.62, 0.95);
        return {
          districts: allDistricts,
          z: fc(rr > 5 ? clinics.map((cl) => turf.circle(cl, rr, { units: 'meters', steps: 72, properties: { key: cl.properties.key } as never })) : []),
          inc: fc(pts.map((f, i) => feat(f.geometry, { key: f.properties.id, c: covering[i].length ? c : 0 }))),
          clinics: fc(clinics),
        };
      },
      columns: ['name', 'radius_m', 'zone_km2', 'incidents_within'],
      rows: (t) =>
        clinics
          .map((cl, i) => ({ cl, i }))
          .sort((a, b) => counts[b.i] - counts[a.i])
          .map(({ cl, i }) => ({
            key: cl.properties.key,
            geom: fullZones[i].geometry,
            cells: {
              name: cl.properties.name,
              radius_m: r,
              zone_km2: fmt(km2(fullZones[i]), 2),
              incidents_within: Math.round(counts[i] * seg(t, 0.62, 0.95)),
            },
          })),
      stats: (t) => [
        { label: 'Covered', value: `${Math.round(covered * seg(t, 0.62, 0.95))} / ${pts.length}` },
        { label: 'Coverage', value: `${fmt((covered / pts.length) * 100 * seg(t, 0.62, 0.95), 0)}%` },
      ],
    };
  },
};

const sJoin: Scene = {
  id: 'st-contains',
  group: 'Measure and relate',
  title: 'Spatial join: which district is each incident in?',
  fns: ['ST_Contains', 'ST_Area', 'GROUP BY'],
  blurb:
    'A spatial join matches rows by location instead of by key. Here every incident is joined to the district polygon that contains it, then counted. Photon recognises ST_Contains in the join condition and runs an optimized spatial join automatically, instead of testing every point against every polygon.',
  params: [],
  camera: HOME,
  duration: 6500,
  sql: () => [
    { text: 'WITH d AS (', stage: 0 },
    { text: '  SELECT name, geom,', stage: 0 },
    { text: '         ST_Area(ST_Transform(geom, 32616)) / 1e6 AS area_km2', stage: 0 },
    { text: '  FROM ems.ref.districts)', stage: 0 },
    { text: 'SELECT d.name AS district,', stage: 2 },
    { text: '       COUNT(*)              AS incidents,', stage: 2 },
    { text: '       COUNT(*) / d.area_km2 AS per_km2', stage: 2 },
    { text: 'FROM ems.silver.incidents i', stage: 0 },
    { text: 'JOIN d ON ST_Contains(d.geom, i.geom)', stage: 1 },
    { text: 'GROUP BY d.name, d.area_km2', stage: 2 },
    { text: 'ORDER BY incidents DESC;', stage: 2 },
  ],
  build: () => {
    const owner = pts.map((f) => districts.findIndex((d) => turf.booleanPointInPolygon(f, d)));
    const sorted = pts.map((f, i) => ({ f, i })).sort((a, b) => a.f.geometry.coordinates[0] - b.f.geometry.coordinates[0]);
    const minX = sorted[0].f.geometry.coordinates[0];
    const maxX = sorted[sorted.length - 1].f.geometry.coordinates[0];
    const finalCounts = districts.map((_, di) => owner.filter((o) => o === di).length);
    const maxC = Math.max(...finalCounts);
    const areas = districts.map((d) => km2(d));
    const order = districts.map((_, i) => i).sort((a, b) => finalCounts[b] - finalCounts[a]);
    const scanX = (t: number) => lerp(minX - 0.005, maxX + 0.005, seg(t, 0.08, 0.88));
    const countsAt = (t: number) => {
      const x = scanX(t);
      const c = districts.map(() => 0);
      for (const { f, i } of sorted) {
        if (f.geometry.coordinates[0] > x) break;
        if (owner[i] >= 0) c[owner[i]]++;
      }
      return c;
    };
    const bb = turf.bbox(county);
    return {
      stages: [
        { at: 0, caption: `Scanning ${pts.length} incident points` },
        { at: 0.08, caption: 'ST_Contains matches each point to the polygon that holds it' },
        { at: 0.88, caption: 'GROUP BY rolls matches up into a count per district' },
      ],
      layers: [
        {
          id: 'd-fill',
          source: 'd',
          type: 'fill',
          paint: {
            'fill-color': ['interpolate', ['linear'], ['get', 'v'], 0, C.paper, 0.5, C.amber, 1, C.red],
            'fill-opacity': ['*', 0.7, ['min', 1, ['*', 3, ['get', 'v']]]],
          },
        },
        districtOutline,
        { id: 'scan', source: 'scan', type: 'line', paint: { 'line-color': C.red, 'line-width': 2, 'line-dasharray': [2, 2] } },
        {
          id: 'inc',
          source: 'inc',
          type: 'circle',
          paint: {
            'circle-radius': ['case', ['==', ['get', 's'], 2], 5.5, ['==', ['get', 's'], 1], 3, 2],
            'circle-color': ['case', ['==', ['get', 's'], 2], C.red, ['==', ['get', 's'], 1], C.ink, C.slate],
            'circle-opacity': ['case', ['==', ['get', 's'], 0], 0.45, 0.85],
          },
        },
      ],
      frame: (t) => {
        const x = scanX(t);
        const counts = countsAt(t);
        return {
          d: fc(districts.map((d, i) => feat(d.geometry, { key: d.properties.key, v: counts[i] / maxC }))),
          districts: allDistricts,
          scan: fc(t > 0.06 && t < 0.9 ? [turf.lineString([[x, bb[1] - 0.01], [x, bb[3] + 0.01]])] : []),
          inc: fc(
            pts.map((f) => {
              const dx = x - f.geometry.coordinates[0];
              return feat(f.geometry, { key: f.properties.id, s: dx < 0 ? 0 : dx < 0.012 ? 2 : 1 });
            }),
          ),
        };
      },
      columns: ['district', 'incidents', 'per_km2'],
      rows: (t) => {
        const counts = countsAt(t);
        return order.map((i) => ({
          key: districts[i].properties.key,
          geom: districts[i].geometry,
          cells: { district: districts[i].properties.name, incidents: counts[i], per_km2: fmt(counts[i] / areas[i], 2) },
        }));
      },
    };
  },
};

const sNearest: Scene = {
  id: 'st-distance',
  group: 'Measure and relate',
  title: 'Find the nearest clinic',
  fns: ['ST_DistanceSphere', 'QUALIFY', 'ROW_NUMBER'],
  blurb:
    'Nearest-neighbour is a distance calculation plus a window function: measure every incident-to-clinic pair on the sphere, then keep the closest one per incident with QUALIFY.',
  params: [{ key: 'n', label: 'Incidents to route', min: 10, max: 250, step: 10, value: 80, unit: '' }],
  camera: HOME,
  duration: 5500,
  sql: () => [
    { text: 'WITH pairs AS (', stage: 0 },
    { text: '  SELECT i.incident_id, c.name AS clinic,', stage: 0 },
    { text: '         ST_DistanceSphere(i.geom, c.geom) AS dist_m', stage: 1 },
    { text: '  FROM ems.silver.incidents i', stage: 0 },
    { text: '  CROSS JOIN ems.ref.clinics c)', stage: 0 },
    { text: 'SELECT incident_id, clinic AS nearest_clinic, dist_m', stage: 2 },
    { text: 'FROM pairs', stage: 2 },
    { text: 'QUALIFY ROW_NUMBER() OVER (', stage: 2 },
    { text: '  PARTITION BY incident_id ORDER BY dist_m) = 1;', stage: 2 },
  ],
  build: (p) => {
    const sample = pts.slice(0, p.n);
    const res = sample.map((f) => {
      let best = 0;
      let bd = Infinity;
      clinics.forEach((c, ci) => {
        const d = turf.distance(f, c, { units: 'meters' });
        if (d < bd) {
          bd = d;
          best = ci;
        }
      });
      return { f, c: clinics[best], d: bd };
    });
    const start = (i: number) => 0.12 + (i / res.length) * 0.5;
    const done = (i: number) => start(i) + 0.25;
    const avg = res.reduce((s, r) => s + r.d, 0) / res.length;
    return {
      stages: [
        { at: 0, caption: `Pairing ${p.n} incidents with ${clinics.length} clinics (${p.n * clinics.length} pairs)` },
        { at: 0.12, caption: 'ST_DistanceSphere measures each pair in metres on the globe' },
        { at: 0.85, caption: 'QUALIFY ROW_NUMBER() = 1 keeps the closest clinic per incident' },
      ],
      layers: [
        districtOutline,
        { id: 'ln', source: 'ln', type: 'line', paint: { 'line-color': C.teal, 'line-width': 1.6, 'line-opacity': 0.8 } },
        {
          id: 'inc',
          source: 'inc',
          type: 'circle',
          paint: { 'circle-radius': 3.2, 'circle-color': ['case', ['get', 'done'], C.teal, C.red], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 },
        },
        clinicLayer(),
      ],
      frame: (t) => ({
        districts: allDistricts,
        ln: fc(
          res
            .map((r, i) => {
              const k = ease(seg(t, start(i), done(i)));
              if (k <= 0) return null;
              const a = r.f.geometry.coordinates;
              const b = r.c.geometry.coordinates;
              return turf.lineString([a, [lerp(a[0], b[0], k), lerp(a[1], b[1], k)]], { key: r.f.properties.id });
            })
            .filter(Boolean) as Feature[],
        ),
        inc: fc(res.map((r, i) => feat(r.f.geometry, { key: r.f.properties.id, done: t >= done(i) }))),
        clinics: fc(clinics),
      }),
      columns: ['incident_id', 'nearest_clinic', 'dist_m'],
      rows: (t) =>
        res
          .filter((_, i) => t >= done(i))
          .map((r) => ({
            key: r.f.properties.id,
            geom: { type: 'LineString', coordinates: [r.f.geometry.coordinates, r.c.geometry.coordinates] } as LineString,
            cells: { incident_id: r.f.properties.id, nearest_clinic: r.c.properties.name, dist_m: Math.round(r.d) },
          })),
      stats: (t) =>
        t < 0.85
          ? []
          : [
              { label: 'Average', value: `${fmt(avg / 1000, 2)} km` },
              { label: 'Farthest', value: `${fmt(Math.max(...res.map((r) => r.d)) / 1000, 2)} km` },
            ],
    };
  },
};

const sWithin: Scene = {
  id: 'st-dwithin',
  group: 'Measure and relate',
  title: 'Search around any point',
  fns: ['ST_DWithin', 'ST_DistanceSphere', 'ST_Point'],
  blurb:
    'ST_DWithin answers "what is within X metres of here?" — the classic radius search behind dispatch, site selection and alerting. Click anywhere on the map to move the search point.',
  params: [{ key: 'd', label: 'Search distance', min: 200, max: 5000, step: 100, value: 1800, unit: 'm' }],
  interaction: 'probe',
  hint: 'Click the map to move the search point',
  camera: HOME,
  duration: 3800,
  sql: (p, ctx) => [
    { text: 'SELECT incident_id, type,', stage: 0 },
    { text: `  ST_DistanceSphere(geom, ST_Point(${ctx.probe[0].toFixed(4)}, ${ctx.probe[1].toFixed(4)}, 4326))`, stage: 0 },
    { text: '                               AS dist_m', stage: 0 },
    { text: 'FROM ems.silver.incidents', stage: 0 },
    { text: 'WHERE ST_DWithin(ST_Transform(geom, 32616),', stage: 1 },
    { text: `        ST_Transform(ST_Point(${ctx.probe[0].toFixed(4)}, ${ctx.probe[1].toFixed(4)}, 4326), 32616), ${p.d})`, stage: 1 },
    { text: 'ORDER BY dist_m;', stage: 2 },
  ],
  build: (p, ctx) => {
    const probe = turf.point(ctx.probe);
    const dist = pts.map((f) => turf.distance(probe, f, { units: 'meters' }));
    const total = dist.filter((d) => d <= p.d).length;
    const ringR = (t: number) => p.d * ease(seg(t, 0.08, 0.8));
    return {
      stages: [
        { at: 0, caption: 'Search point set with ST_Point' },
        { at: 0.08, caption: `ST_DWithin keeps incidents within ${fmt(p.d, 0)} m` },
        { at: 0.8, caption: `${total} incidents found, sorted nearest first` },
      ],
      layers: [
        districtOutline,
        { id: 'ring-fill', source: 'ring', type: 'fill', paint: { 'fill-color': C.red, 'fill-opacity': 0.08 } },
        { id: 'ring-line', source: 'ring', type: 'line', paint: { 'line-color': C.red, 'line-width': 2 } },
        {
          id: 'inc',
          source: 'inc',
          type: 'circle',
          paint: {
            'circle-radius': ['case', ['get', 'in'], 4.5, 2.2],
            'circle-color': ['case', ['get', 'in'], C.red, C.slate],
            'circle-opacity': ['case', ['get', 'in'], 0.95, 0.5],
            'circle-stroke-color': '#fff',
            'circle-stroke-width': ['case', ['get', 'in'], 1, 0],
          },
        },
        {
          id: 'probe',
          source: 'probe',
          type: 'circle',
          paint: { 'circle-radius': 8, 'circle-color': C.ink, 'circle-stroke-color': C.amber, 'circle-stroke-width': 3 },
        },
      ],
      frame: (t) => {
        const rr = ringR(t);
        return {
          districts: allDistricts,
          ring: fc(rr > 5 ? [turf.circle(probe, rr, { units: 'meters', steps: 96 })] : []),
          inc: fc(pts.map((f, i) => feat(f.geometry, { key: f.properties.id, in: dist[i] <= rr }))),
          probe: fc([probe]),
        };
      },
      columns: ['incident_id', 'type', 'dist_m'],
      rows: (t) => {
        const rr = ringR(t);
        return pts
          .map((f, i) => ({ f, d: dist[i] }))
          .filter((x) => x.d <= rr)
          .sort((a, b) => a.d - b.d)
          .slice(0, 60)
          .map(({ f, d }) => ({ key: f.properties.id, geom: f.geometry, cells: { incident_id: f.properties.id, type: f.properties.type, dist_m: Math.round(d) } }));
      },
      stats: (t) => [{ label: 'Within', value: `${dist.filter((d) => d <= ringR(t)).length}` }],
    };
  },
};

const sOverlay: Scene = {
  id: 'st-intersection',
  group: 'Overlay and shape',
  title: 'Overlay a flood zone on districts',
  fns: ['ST_Buffer', 'ST_Intersects', 'ST_Intersection', 'ST_Area'],
  blurb:
    'Overlay analysis cuts one layer by another. We buffer the river into a flood zone, keep districts that touch it with ST_Intersects, and use ST_Intersection to measure exactly how much of each district is exposed — and which clinics sit inside it.',
  params: [{ key: 'w', label: 'Flood zone width', min: 200, max: 2500, step: 50, value: 900, unit: 'm' }],
  camera: { ...HOME, zoom: 10.2 },
  duration: 6200,
  sql: (p) => [
    { text: 'WITH flood AS (', stage: 0 },
    { text: `  SELECT ST_Buffer(ST_Transform(geom, 32616), ${p.w}) AS zone`, stage: 1 },
    { text: "  FROM ems.ref.rivers WHERE name = 'White River')", stage: 0 },
    { text: 'SELECT d.name,', stage: 2 },
    { text: '  ST_Area(ST_Intersection(ST_Transform(d.geom, 32616), f.zone))', stage: 2 },
    { text: '    / 1e6                          AS flooded_km2', stage: 2 },
    { text: 'FROM ems.ref.districts d CROSS JOIN flood f', stage: 2 },
    { text: 'WHERE ST_Intersects(ST_Transform(d.geom, 32616), f.zone);', stage: 2 },
  ],
  build: (p) => {
    const riverS = turf.simplify(river, { tolerance: 0.0002 });
    const zone = turf.buffer(riverS, p.w, { units: 'meters', steps: 6 });
    const pieces = districts
      .map((d) => {
        const piece = zone ? turf.intersect(turf.featureCollection([d, zone as Feature<Polygon | MultiPolygon>])) : null;
        return piece ? { d, piece, a: km2(piece), total: km2(d) } : null;
      })
      .filter(Boolean) as { d: (typeof districts)[number]; piece: Feature<Polygon | MultiPolygon>; a: number; total: number }[];
    pieces.sort((a, b) => b.a - a.a);
    const atRisk = clinics.filter((c) => zone && turf.booleanPointInPolygon(c, zone as Feature<Polygon>));
    const riverLen = turf.length(river);
    const pieceAt = (i: number) => 0.6 + (i / Math.max(1, pieces.length)) * 0.3;
    return {
      stages: [
        { at: 0, caption: 'Tracing the White River centreline' },
        { at: 0.32, caption: `ST_Buffer widens it into a ${fmt(p.w, 0)} m flood zone` },
        { at: 0.58, caption: 'ST_Intersection cuts each district by the zone and measures the overlap' },
      ],
      layers: [
        districtOutline,
        { id: 'zone-fill', source: 'zone', type: 'fill', paint: { 'fill-color': C.tealLight, 'fill-opacity': ['get', 'o'] } },
        { id: 'piece-fill', source: 'piece', type: 'fill', paint: { 'fill-color': C.amber, 'fill-opacity': 0.75 } },
        { id: 'piece-line', source: 'piece', type: 'line', paint: { 'line-color': C.ink, 'line-width': 1.2 } },
        { id: 'river', source: 'river', type: 'line', paint: { 'line-color': C.teal, 'line-width': 3 } },
        clinicLayer(),
      ],
      frame: (t) => {
        const drawn = seg(t, 0, 0.3);
        return {
          districts: allDistricts,
          river: fc(drawn > 0.002 ? [turf.lineSliceAlong(river, 0, riverLen * drawn)] : []),
          zone: fc(zone && t >= 0.32 ? [feat(zone.geometry, { o: 0.55 * ease(seg(t, 0.32, 0.55)) })] : []),
          piece: fc(pieces.filter((_, i) => t >= pieceAt(i)).map((x) => feat(x.piece.geometry, { key: x.d.properties.key }))),
          clinics: fc(
            clinics.map((c) =>
              feat(c.geometry, {
                key: c.properties.key,
                color: t > 0.9 && atRisk.includes(c) ? C.red : C.ink,
                r: t > 0.9 && atRisk.includes(c) ? 9 : 6,
              }),
            ),
          ),
        };
      },
      columns: ['name', 'flooded_km2', 'pct_of_district'],
      rows: (t) =>
        pieces
          .filter((_, i) => t >= pieceAt(i))
          .map((x) => ({
            key: x.d.properties.key,
            geom: x.piece.geometry,
            cells: { name: x.d.properties.name, flooded_km2: fmt(x.a, 2), pct_of_district: `${fmt((x.a / x.total) * 100, 1)}%` },
          })),
      stats: (t) =>
        t < 0.9
          ? []
          : [
              { label: 'Flooded', value: `${fmt(pieces.reduce((s, x) => s + x.a, 0), 1)} km²` },
              { label: 'Clinics at risk', value: atRisk.length ? atRisk.map((c) => c.properties.name).join(', ') : 'none' },
            ],
    };
  },
};

const sSimplify: Scene = {
  id: 'st-simplify',
  group: 'Overlay and shape',
  title: 'Simplify detailed shapes',
  fns: ['ST_Simplify', 'ST_NPoints'],
  blurb:
    'Survey-grade boundaries carry thousands of vertices that a web map at city zoom never needs. ST_Simplify (Douglas–Peucker) removes vertices within a tolerance, so tiles and dashboards stay fast. Raise the tolerance and watch the vertex count fall.',
  params: [{ key: 'tol', label: 'Tolerance', min: 10, max: 800, step: 10, value: 250, unit: 'm' }],
  camera: HOME,
  duration: 4200,
  sql: (p) => [
    { text: 'SELECT name,', stage: 0 },
    { text: '  ST_NPoints(geom)                         AS vertices_before,', stage: 0 },
    { text: `  ST_NPoints(ST_Simplify(geom, ${(p.tol / 111320).toFixed(5)}))   AS vertices_after`, stage: 1 },
    { text: 'FROM ems.ref.boundaries;', stage: 0 },
    { text: `-- tolerance is in CRS units: ${p.tol} m ≈ ${(p.tol / 111320).toFixed(5)}°`, stage: 2 },
  ],
  build: (p) => {
    const geoms = [county as Feature, river as Feature];
    const before = geoms.map((g) => countVertices(g.geometry));
    const simplifyAt = (t: number) => {
      const tol = (p.tol * ease(seg(t, 0.1, 0.85))) / 111320;
      return geoms.map((g) => (tol > 0 ? turf.simplify(g, { tolerance: tol, highQuality: true }) : g));
    };
    return {
      stages: [
        { at: 0, caption: `Original shapes: ${before.reduce((a, b) => a + b, 0)} vertices` },
        { at: 0.1, caption: `ST_Simplify removes vertices within ${p.tol} m of the line` },
        { at: 0.85, caption: 'Same outline, a fraction of the payload' },
      ],
      layers: [
        { id: 'orig', source: 'orig', type: 'line', paint: { 'line-color': C.slate, 'line-width': 1, 'line-opacity': 0.7 } },
        { id: 'simp', source: 'simp', type: 'line', paint: { 'line-color': C.red, 'line-width': 2 } },
        { id: 'verts', source: 'verts', type: 'circle', paint: { 'circle-radius': 2.4, 'circle-color': C.ink } },
      ],
      frame: (t) => {
        const s = simplifyAt(t);
        const verts: Feature[] = [];
        s.forEach((g) => turf.coordEach(g, (c) => verts.push(turf.point(c))));
        return {
          orig: fc(geoms),
          simp: fc(s.map((g, i) => feat(g.geometry, { key: i ? 'river' : 'county' }))),
          verts: fc(verts),
        };
      },
      columns: ['name', 'vertices_before', 'vertices_after', 'reduction'],
      rows: (t) => {
        const s = simplifyAt(t);
        return s.map((g, i) => {
          const after = countVertices(g.geometry);
          return {
            key: i ? 'river' : 'county',
            geom: g.geometry,
            cells: {
              name: i ? 'White River' : 'County boundary',
              vertices_before: before[i],
              vertices_after: after,
              reduction: `${fmt((1 - after / before[i]) * 100, 0)}%`,
            },
          };
        });
      },
    };
  },
};

// ---------------------------------------------------------------- H3
const RES_EDGE_KM: Record<number, number> = { 6: 3.72, 7: 1.41, 8: 0.53, 9: 0.2 };
const sH3: Scene = {
  id: 'h3-agg',
  group: 'Index with H3',
  title: 'Aggregate points into H3 hexagons',
  fns: ['h3_longlatash3string', 'h3_boundaryaswkt', 'ST_X', 'ST_Y'],
  blurb:
    'H3 is a global grid of hexagons. Giving every point a cell ID turns heavy geometry joins into fast equality joins and GROUP BYs — and the same cell IDs line up across every dataset you index. Change the resolution to trade detail for coverage.',
  params: [{ key: 'res', label: 'H3 resolution', min: 6, max: 9, step: 1, value: 8, unit: '' }],
  camera: { center: [CENTER[0], CENTER[1] - 0.03], zoom: 10.6, pitch: 52, bearing: -18 },
  duration: 5200,
  sql: (p) => [
    { text: 'SELECT cell,', stage: 2 },
    { text: '       COUNT(*)               AS incidents,', stage: 2 },
    { text: '       h3_boundaryaswkt(cell) AS hex_wkt', stage: 2 },
    { text: 'FROM (', stage: 1 },
    { text: `  SELECT h3_longlatash3string(ST_X(geom), ST_Y(geom), ${p.res}) AS cell`, stage: 1 },
    { text: '  FROM ems.silver.incidents)', stage: 0 },
    { text: 'GROUP BY cell ORDER BY incidents DESC;', stage: 2 },
  ],
  build: (p) => {
    const counts = new Map<string, number>();
    pts.forEach((f) => {
      const [x, y] = f.geometry.coordinates;
      const c = latLngToCell(y, x, p.res);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    });
    const cells = [...counts.entries()].map(([cell, n]) => {
      const ring = cellToBoundary(cell, true);
      const poly: Polygon = { type: 'Polygon', coordinates: [ring] };
      const cen = turf.centroid(poly).geometry.coordinates;
      return { cell, n, poly, d: turf.distance(cen, CENTER) };
    });
    const max = Math.max(...cells.map((c) => c.n));
    const maxD = Math.max(...cells.map((c) => c.d));
    const sorted = [...cells].sort((a, b) => b.n - a.n);
    const hScale = 2600;
    return {
      stages: [
        { at: 0, caption: `${pts.length} points, edge length ≈ ${RES_EDGE_KM[p.res]} km at resolution ${p.res}` },
        { at: 0.12, caption: 'h3_longlatash3string assigns every point a hexagon ID' },
        { at: 0.45, caption: `GROUP BY cell — ${cells.length} hexagons, the tallest holds ${max} incidents` },
      ],
      layers: [
        {
          id: 'inc',
          source: 'inc',
          type: 'circle',
          paint: { 'circle-radius': 2.2, 'circle-color': C.ink, 'circle-opacity': ['get', 'o'] },
        },
        {
          id: 'hex',
          source: 'hex',
          type: 'fill-extrusion',
          paint: {
            'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'v'], 0, C.tealLight, 0.45, C.amber, 1, C.red],
            'fill-extrusion-height': ['get', 'h'],
            'fill-extrusion-opacity': 0.88,
          },
        },
      ],
      frame: (t) => {
        const assign = seg(t, 0.12, 0.45);
        return {
          inc: fc(pts.map((f) => feat(f.geometry, { o: 0.75 * (1 - seg(t, 0.4, 0.7)) }))),
          hex: fc(
            cells.map((c) => {
              const s = 0.12 + (c.d / maxD) * 0.25;
              const appear = t >= s * (assign > 0 ? 1 : 2) ? 1 : 0;
              const grow = ease(seg(t, 0.45 + (c.d / maxD) * 0.2, 0.7 + (c.d / maxD) * 0.25));
              return feat(c.poly, { key: c.cell, v: c.n / max, h: appear ? 30 + grow * (c.n / max) * hScale : 0 });
            }),
          ),
        };
      },
      columns: ['cell', 'incidents', 'hex_wkt'],
      rows: (t) =>
        t < 0.45
          ? []
          : sorted.slice(0, 50).map((c) => ({ key: c.cell, geom: c.poly, cells: { cell: c.cell, incidents: c.n, hex_wkt: shortWKT(c.poly, 28) } })),
      stats: () => [
        { label: 'Cells', value: `${cells.length}` },
        { label: 'Edge', value: `${RES_EDGE_KM[p.res]} km` },
      ],
    };
  },
};

const H3_RES = 8;
const incCell = pts.map((f) => latLngToCell(f.geometry.coordinates[1], f.geometry.coordinates[0], H3_RES));
const sKring: Scene = {
  id: 'h3-kring',
  group: 'Index with H3',
  title: 'Expand rings of neighbours',
  fns: ['h3_kring', 'h3_distance', 'h3_longlatash3'],
  blurb:
    'Because H3 cells know their neighbours, "everything within k steps" is a lookup, not a geometry calculation. h3_kring returns the disk of cells around a centre; h3_distance labels each ring. Click the map to pick a new centre.',
  params: [{ key: 'k', label: 'Ring size (k)', min: 1, max: 8, step: 1, value: 4, unit: '' }],
  interaction: 'probe',
  hint: 'Click the map to choose a centre cell',
  camera: { ...HOME, zoom: 11.4 },
  duration: 4800,
  sql: (p, ctx) => [
    { text: 'WITH center AS (', stage: 0 },
    { text: `  SELECT h3_longlatash3(${ctx.probe[0].toFixed(4)}, ${ctx.probe[1].toFixed(4)}, ${H3_RES}) AS c),`, stage: 0 },
    { text: 'rings AS (', stage: 1 },
    { text: `  SELECT c, explode(h3_kring(c, ${p.k})) AS cell FROM center)`, stage: 1 },
    { text: 'SELECT h3_distance(c, cell)  AS ring,', stage: 2 },
    { text: '       COUNT(DISTINCT cell)  AS cells,', stage: 2 },
    { text: '       COUNT(i.incident_id)  AS incidents', stage: 2 },
    { text: 'FROM rings LEFT JOIN ems.gold.incidents_h3 i USING (cell)', stage: 2 },
    { text: 'GROUP BY ring ORDER BY ring;', stage: 2 },
  ],
  build: (p, ctx) => {
    const center = latLngToCell(ctx.probe[1], ctx.probe[0], H3_RES);
    const disk = gridDisk(center, p.k).map((cell) => ({
      cell,
      ring: gridDistance(center, cell),
      poly: { type: 'Polygon', coordinates: [cellToBoundary(cell, true)] } as Polygon,
      n: incCell.filter((c) => c === cell).length,
    }));
    const ringAt = (r: number) => 0.08 + (r / (p.k + 1)) * 0.75;
    const ringRows = Array.from({ length: p.k + 1 }, (_, r) => {
      const cs = disk.filter((d) => d.ring === r);
      const geom = cs.length === 1 ? cs[0].poly : turf.union(fc(cs.map((c) => feat(c.poly))) as FeatureCollection<Polygon>)?.geometry;
      return { r, cells: cs.length, n: cs.reduce((s, c) => s + c.n, 0), geom };
    });
    return {
      stages: [
        { at: 0, caption: `Centre cell ${center}` },
        { at: 0.08, caption: `h3_kring adds ring after ring out to k = ${p.k}` },
        { at: 0.85, caption: `${disk.length} cells — counts join on cell ID, no geometry math` },
      ],
      layers: [
        {
          id: 'hex-fill',
          source: 'hex',
          type: 'fill',
          paint: {
            'fill-color': ['interpolate', ['linear'], ['get', 'rr'], 0, C.red, 0.01, C.amber, 1, C.tealLight],
            'fill-opacity': ['get', 'o'],
          },
        },
        { id: 'hex-line', source: 'hex', type: 'line', paint: { 'line-color': '#fff', 'line-width': 1.2 } },
        { id: 'inc', source: 'inc', type: 'circle', paint: { 'circle-radius': 2.4, 'circle-color': C.ink, 'circle-opacity': 0.8 } },
      ],
      frame: (t) => ({
        hex: fc(
          disk
            .filter((d) => t >= ringAt(d.ring))
            .map((d) => feat(d.poly, { key: `ring-${d.ring}`, rr: d.ring / p.k, o: 0.25 + 0.5 * (1 - seg(t, ringAt(d.ring), ringAt(d.ring) + 0.12)) + 0.1 })),
        ),
        inc: fc(pts as Feature[]),
      }),
      columns: ['ring', 'cells', 'incidents'],
      rows: (t) =>
        ringRows.filter((r) => t >= ringAt(r.r)).map((r) => ({ key: `ring-${r.r}`, geom: r.geom as Geometry, cells: { ring: r.r, cells: r.cells, incidents: r.n } })),
    };
  },
};

// ---------------------------------------------------------------- polygon → H3
const cellPolygon = (cell: string): Polygon => ({ type: 'Polygon', coordinates: [cellToBoundary(cell, true)] });
const asDistrict = (key: string) => districts.find((d) => d.properties.key === key) ?? districts[0];

const sFill: Scene = {
  id: 'h3-fill',
  group: 'Index with H3',
  title: 'Fill polygons with H3 cells',
  fns: ['h3_polyfillash3', 'h3_tessellateaswkb', 'ST_AsWKB'],
  blurb:
    'Two ways to turn a polygon into H3 cells. h3_polyfillash3 keeps every cell whose centre is inside, which is fast but leaves the edges ragged. h3_tessellateaswkb covers the polygon exactly: whole "core" cells inside, plus boundary cells clipped into chips. Click any district to fill it.',
  params: [{ key: 'res', label: 'H3 resolution', min: 7, max: 9, step: 1, value: 8, unit: '' }],
  interaction: 'select',
  hint: 'Click a district to fill it',
  camera: { center: turf.centroid(districts[0]).geometry.coordinates as [number, number], zoom: 11.35, pitch: 0, bearing: 0 },
  duration: 8000,
  sql: (p, ctx) => [
    { text: 'WITH d AS (', stage: 0 },
    { text: '  SELECT ST_AsWKB(geom) AS wkb   -- H3 functions take WKB or WKT, not GEOMETRY', stage: 0 },
    { text: `  FROM ems.ref.districts WHERE name = '${asDistrict(ctx.selected).properties.name}'),`, stage: 0 },
    { text: `fill AS (SELECT explode(h3_polyfillash3(wkb, ${p.res})) AS cell FROM d),`, stage: 1 },
    { text: `tess AS (SELECT inline(h3_tessellateaswkb(wkb, ${p.res})) FROM d)  -- cellid, core, chip`, stage: 3 },
    { text: "SELECT 'h3_polyfillash3' AS fn, COUNT(*) AS cells, NULL AS core_cells", stage: 1 },
    { text: 'FROM fill', stage: 1 },
    { text: 'UNION ALL', stage: 3 },
    { text: "SELECT 'h3_tessellateaswkb', COUNT(*), COUNT_IF(core)", stage: 3 },
    { text: 'FROM tess;', stage: 3 },
  ],
  build: (p, ctx) => {
    const dist = asDistrict(ctx.selected);
    const polys = dist.geometry.type === 'Polygon' ? [dist.geometry.coordinates] : dist.geometry.coordinates;
    const center = turf.centroid(dist).geometry.coordinates;
    const distTo = (c: string) => turf.distance(center, turf.centroid(cellPolygon(c)).geometry.coordinates);

    // h3_polyfillash3 = centre containment; h3_tessellateaswkb = every overlapping cell, clipped
    const fillSet = new Set(polys.flatMap((poly) => polygonToCells(poly, p.res, true)));
    const overlap = [...new Set(polys.flatMap((poly) => polygonToCellsExperimental(poly, p.res, POLYGON_TO_CELLS_FLAGS.containmentOverlapping, true)))];
    const tess = overlap
      .map((cell) => {
        const poly = cellPolygon(cell);
        const chip = turf.intersect(turf.featureCollection([feat(poly) as Feature<Polygon>, dist as Feature<Polygon | MultiPolygon>]));
        if (!chip) return null;
        const cellA = turf.area(poly);
        const chipA = turf.area(chip);
        return { cell, poly, chip: chip.geometry, cellA, chipA, core: chipA / cellA > 0.9999, d: distTo(cell) };
      })
      .filter(Boolean) as { cell: string; poly: Polygon; chip: Polygon | MultiPolygon; cellA: number; chipA: number; core: boolean; d: number }[];
    const byCell = new Map(tess.map((x) => [x.cell, x]));
    const fill = [...fillSet].map((cell) => ({ cell, poly: cellPolygon(cell), d: distTo(cell), info: byCell.get(cell) }));
    const overhang = fill
      .filter((x) => x.info && !x.info.core)
      .map((x) => turf.difference(turf.featureCollection([feat(x.poly) as Feature<Polygon>, dist as Feature<Polygon | MultiPolygon>])))
      .filter(Boolean) as Feature<Polygon | MultiPolygon>[];
    const missed = tess.filter((x) => !fillSet.has(x.cell));
    const areaPoly = km2(dist);
    const fillKm2 = fill.reduce((s, x) => s + turf.area(x.poly), 0) / 1e6;
    const overKm2 = overhang.reduce((s, x) => s + turf.area(x), 0) / 1e6;
    const missKm2 = missed.reduce((s, x) => s + x.chipA, 0) / 1e6;
    const tessKm2 = tess.reduce((s, x) => s + x.chipA, 0) / 1e6;
    const core = tess.filter((x) => x.core).length;
    const maxD = Math.max(...tess.map((x) => x.d), 0.001);
    const name = dist.properties.name;

    return {
      stages: [
        { at: 0, caption: `${name}: ${fmt(areaPoly, 1)} km² polygon` },
        { at: 0.1, caption: `h3_polyfillash3 keeps the ${fill.length} cells whose centres fall inside` },
        { at: 0.42, caption: `Ragged edges: ${fmt(overKm2, 2)} km² hangs outside (red), ${fmt(missKm2, 2)} km² is missed (dark)` },
        { at: 0.52, caption: `h3_tessellateaswkb: ${core} whole core cells plus ${tess.length - core} boundary chips` },
        { at: 0.9, caption: `${tess.length} cells cover the polygon exactly, chips clipped to the boundary` },
      ],
      layers: [
        { id: 'd-hit', source: 'dall', type: 'fill', paint: { 'fill-color': C.teal, 'fill-opacity': 0.03 } },
        { id: 'd-all', source: 'dall', type: 'line', paint: { 'line-color': C.ink, 'line-width': 1, 'line-opacity': 0.25 } },
        { id: 'fill-f', source: 'fill', type: 'fill', paint: { 'fill-color': C.tealLight, 'fill-opacity': ['get', 'o'] } },
        { id: 'fill-l', source: 'fill', type: 'line', paint: { 'line-color': '#fff', 'line-width': 1.2, 'line-opacity': ['get', 'o'] } },
        { id: 'over', source: 'over', type: 'fill', paint: { 'fill-color': C.red, 'fill-opacity': ['get', 'o'] } },
        { id: 'miss', source: 'miss', type: 'fill', paint: { 'fill-color': C.ink, 'fill-opacity': ['get', 'o'] } },
        {
          id: 'tess-f',
          source: 'tess',
          type: 'fill',
          paint: { 'fill-color': ['case', ['get', 'core'], C.teal, C.amber], 'fill-opacity': ['*', 0.7, ['get', 'o']] },
        },
        { id: 'tess-l', source: 'tess', type: 'line', paint: { 'line-color': '#fff', 'line-width': 1.2, 'line-opacity': ['get', 'o'] } },
        { id: 'outline', source: 'outline', type: 'line', paint: { 'line-color': C.ink, 'line-width': 3 } },
      ],
      frame: (t) => {
        const fillOut = 1 - seg(t, 0.52, 0.6);
        const edge = seg(t, 0.42, 0.48) * (1 - seg(t, 0.52, 0.58));
        return {
          dall: fc(districts.map((d) => feat(d.geometry, { key: d.properties.key }))),
          outline: fc(t > 0 ? [turf.polygonToLine(dist) as Feature] : []),
          fill: fc(
            fill
              .map((x) => ({ x, o: ease(seg(t, 0.1 + (x.d / maxD) * 0.25, 0.16 + (x.d / maxD) * 0.25)) * 0.85 * fillOut }))
              .filter(({ o }) => o > 0)
              .map(({ x, o }) => feat(x.poly, { o })),
          ),
          over: fc(edge > 0 ? overhang.map((g) => feat(g.geometry, { o: 0.85 * edge })) : []),
          miss: fc(edge > 0 ? missed.map((x) => feat(x.chip, { o: 0.7 * edge })) : []),
          tess: fc(
            tess
              .map((x) => ({ x, o: ease(seg(t, 0.55 + (x.d / maxD) * 0.3, 0.6 + (x.d / maxD) * 0.3)) }))
              .filter(({ o }) => o > 0)
              .map(({ x, o }) => feat(x.chip, { core: x.core, o })),
          ),
        };
      },
      columns: ['function', 'cells', 'covered_km2', 'overhang_km2', 'missed_km2'],
      rows: (t) => [
        ...(t >= 0.42
          ? [{ key: 'row-fill', geom: dist.geometry, cells: { function: 'h3_polyfillash3', cells: fill.length, covered_km2: fmt(fillKm2, 2), overhang_km2: fmt(overKm2, 2), missed_km2: fmt(missKm2, 2) } }]
          : []),
        ...(t >= 0.9
          ? [{ key: 'row-tess', geom: dist.geometry, cells: { function: 'h3_tessellateaswkb', cells: tess.length, covered_km2: fmt(tessKm2, 2), overhang_km2: '0', missed_km2: '0' } }]
          : []),
      ],
      stats: (t) => [
        { label: 'Polygon', value: `${fmt(areaPoly, 2)} km²` },
        ...(t >= 0.52 ? [{ label: 'Core cells', value: `${core}` }, { label: 'Boundary chips', value: `${tess.length - core}` }] : []),
      ],
    };
  },
};

// ---------------------------------------------------------------- interop
const nameOf = (key: string) =>
  ([...districts, ...clinics] as Feature[]).find((f) => (f.properties as { key: string }).key === key)?.properties?.name ?? key;
const sFormats: Scene = {
  id: 'formats',
  group: 'Connect',
  title: 'Speak every GIS format',
  fns: ['ST_AsText', 'ST_AsGeoJSON', 'ST_AsWKB', 'ST_AsEWKT', 'ST_GeoHash'],
  blurb:
    'Other GIS tools don’t need to understand Delta — they need WKT, WKB or GeoJSON. One geometry column can be served in all of them. Click a clinic, district or incident to see it encoded; click a result row to copy it.',
  params: [],
  interaction: 'select',
  hint: 'Click a clinic, district or incident',
  camera: HOME,
  duration: 2600,
  sql: (_p, ctx) => {
    const isPoint = !ctx.selected.startsWith('district');
    const table = ctx.selected.startsWith('district') ? 'districts' : ctx.selected.startsWith('clinic') ? 'clinics' : 'incidents';
    return [
      { text: 'SELECT', stage: 1 },
      { text: '  ST_AsText(geom)     AS wkt,', stage: 1 },
      { text: '  ST_AsGeoJSON(geom)  AS geojson,', stage: 1 },
      { text: '  ST_AsWKB(geom)      AS wkb,', stage: 1 },
      { text: `  ST_AsEWKT(geom)     AS ewkt${isPoint ? ',' : ''}`, stage: 1 },
      ...(isPoint ? [{ text: '  ST_GeoHash(geom)    AS geohash', stage: 1 }] : []),
      { text: `FROM ems.${table === 'incidents' ? 'silver' : 'ref'}.${table}`, stage: 0 },
      { text: table === 'incidents' ? `WHERE incident_id = '${ctx.selected}';` : `WHERE name = '${nameOf(ctx.selected)}';`, stage: 0 },
    ];
  },
  build: (_p, ctx) => {
    const all: Feature[] = [...districts, ...clinics, ...pts];
    const sel = all.find((f) => (f.properties as { key: string }).key === ctx.selected) ?? clinics[0];
    const g = sel.geometry;
    const name = (sel.properties as { name?: string; id?: string }).name ?? (sel.properties as { id: string }).id;
    const outputs: [string, string][] = [
      ['ST_AsText', toWKT(g)],
      ['ST_AsGeoJSON', JSON.stringify(g, (_k, v) => (typeof v === 'number' ? +v.toFixed(6) : v))],
      ['ST_AsWKB', toWKBHex(g)],
      ['ST_AsEWKT', `SRID=4326;${toWKT(g)}`],
    ];
    if (g.type === 'Point') outputs.push(['ST_GeoHash', geohash(g.coordinates[0], g.coordinates[1], 12)]);
    return {
      stages: [
        { at: 0, caption: `Selected: ${name}` },
        { at: 0.3, caption: 'One GEOMETRY value, every interchange format' },
      ],
      layers: [
        { id: 'd-fill', source: 'districts', type: 'fill', paint: { 'fill-color': C.teal, 'fill-opacity': 0.04 } },
        districtOutline,
        { id: 'inc', source: 'inc', type: 'circle', paint: { 'circle-radius': 2.4, 'circle-color': C.slate, 'circle-opacity': 0.6 } },
        clinicLayer(),
        { id: 'sel-fill', source: 'sel', type: 'fill', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': C.amber, 'fill-opacity': 0.5 } },
        { id: 'sel-line', source: 'sel', type: 'line', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': C.ink, 'line-width': 2.5 } },
        {
          id: 'sel-pt',
          source: 'sel',
          type: 'circle',
          filter: ['==', ['geometry-type'], 'Point'],
          paint: { 'circle-radius': ['get', 'r'], 'circle-color': C.amber, 'circle-stroke-color': C.ink, 'circle-stroke-width': 2.5 },
        },
      ],
      frame: (t) => ({
        districts: fc(districts as Feature[]),
        inc: fc(pts as Feature[]),
        clinics: fc(clinics),
        sel: fc([feat(g, { r: 8 + 6 * Math.sin(seg(t, 0, 0.6) * Math.PI) })]),
      }),
      columns: ['function', 'output'],
      rows: (t) =>
        outputs.filter((_, i) => t >= 0.3 + i * 0.12).map(([fn, out]) => ({ key: `fmt-${fn}`, geom: g, cells: { function: fn, output: out } })),
    };
  },
};

const sEcosystem: Scene = {
  id: 'ecosystem',
  group: 'Connect',
  title: 'Plug into the GIS stack',
  fns: ['Unity Catalog', 'Delta / Iceberg', 'Databricks SQL'],
  blurb:
    'Databricks sits in the middle of the GIS stack rather than replacing it: ingest from the formats and systems you already run, process at lakehouse scale, govern once in Unity Catalog, then serve results to desktop GIS, BI and web maps. Select any system to see how it connects.',
  params: [],
  camera: HOME,
  duration: 3000,
  sql: () => [
    { text: '-- Publish a governed gold table any GIS client can read', stage: 0 },
    { text: 'CREATE OR REPLACE TABLE ems.gold.district_load AS', stage: 0 },
    { text: 'WITH counts AS (', stage: 0 },
    { text: '  SELECT d.name, COUNT(i.incident_id) AS incidents', stage: 0 },
    { text: '  FROM ems.ref.districts d', stage: 0 },
    { text: '  LEFT JOIN ems.silver.incidents i ON ST_Contains(d.geom, i.geom)', stage: 0 },
    { text: '  GROUP BY d.name)', stage: 0 },
    { text: 'SELECT d.name, c.incidents, d.geom,', stage: 0 },
    { text: '       ST_AsWKB(d.geom)     AS wkb,', stage: 0 },
    { text: '       ST_AsGeoJSON(d.geom) AS geojson', stage: 0 },
    { text: 'FROM ems.ref.districts d JOIN counts c USING (name);', stage: 0 },
    { text: 'GRANT SELECT ON TABLE ems.gold.district_load TO `gis-analysts`;', stage: 1 },
  ],
  build: () => ({
    custom: 'ecosystem',
    stages: [
      { at: 0, caption: 'Ingest → process → govern → serve' },
      { at: 0.6, caption: 'One governed copy, read by every tool' },
    ],
    layers: [],
    frame: () => ({}),
    columns: [],
    rows: () => [],
  }),
};

export const SCENES: Scene[] = [sPoint, sPolygons, sBuffer, sJoin, sNearest, sWithin, sOverlay, sSimplify, sH3, sKring, sFill, sFormats, sEcosystem];
export const GROUPS = [...new Set(SCENES.map((s) => s.group))];

export const DEFAULT_PROBE: [number, number] = [-86.158, 39.772];
export type { Point };
