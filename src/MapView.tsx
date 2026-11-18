import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Geometry } from 'geojson';
import { C, type Camera, type Output } from './scenes';

export type BasemapId = 'positron' | 'voyager' | 'dark' | 'osm' | 'esri';

const raster = (tiles: string, attribution: string): StyleSpecification => ({
  version: 8,
  sources: { base: { type: 'raster', tiles: [tiles], tileSize: 256, attribution, maxzoom: 19 } },
  layers: [{ id: 'base', type: 'raster', source: 'base' }],
});

export const BASEMAPS: { id: BasemapId; label: string; provider: string; style: string | StyleSpecification }[] = [
  { id: 'positron', label: 'Light', provider: 'CARTO vector tiles', style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json' },
  { id: 'voyager', label: 'Streets', provider: 'CARTO vector tiles', style: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json' },
  { id: 'dark', label: 'Dark', provider: 'CARTO vector tiles', style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json' },
  { id: 'osm', label: 'OSM', provider: 'OpenStreetMap raster tiles', style: raster('https://tile.openstreetmap.org/{z}/{x}/{y}.png', '© OpenStreetMap contributors') },
  {
    id: 'esri',
    label: 'Imagery',
    provider: 'Esri ArcGIS World Imagery',
    style: raster('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', 'Esri, Maxar, Earthstar Geographics'),
  },
];

type Props = {
  sceneId: string;
  output: Output;
  t: number;
  camera: Camera;
  basemap: BasemapId;
  highlight?: Geometry;
  onHoverKey: (key: string | null) => void;
  onMapClick: (lngLat: [number, number], key: string | null) => void;
};

const HL = '__hl';

export function MapView({ sceneId, output, t, camera, basemap, highlight, onHoverKey, onMapClick }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const installed = useRef<{ layers: string[]; sources: string[] }>({ layers: [], sources: [] });
  const ready = useRef(false);
  const latest = useRef({ output, t, highlight, onHoverKey, onMapClick });
  latest.current = { output, t, highlight, onHoverKey, onMapClick };

  const install = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const { output: o, t: tt } = latest.current;
    for (const id of installed.current.layers) if (m.getLayer(id)) m.removeLayer(id);
    for (const id of installed.current.sources) if (m.getSource(id)) m.removeSource(id);
    const data = o.frame(tt);
    const sources = new Set(o.layers.map((l) => l.source));
    for (const s of sources) m.addSource(s, { type: 'geojson', data: data[s] ?? { type: 'FeatureCollection', features: [] } });
    for (const l of o.layers) {
      m.addLayer({ id: l.id, source: l.source, type: l.type, paint: l.paint, ...(l.layout ? { layout: l.layout } : {}), ...(l.filter ? { filter: l.filter } : {}) } as maplibregl.AddLayerObject);
    }
    // highlight layers always on top
    if (!m.getSource(HL)) {
      m.addSource(HL, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: `${HL}-fill`, source: HL, type: 'fill', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': C.amber, 'fill-opacity': 0.35 } });
      m.addLayer({ id: `${HL}-line`, source: HL, type: 'line', paint: { 'line-color': C.ink, 'line-width': 3 } });
      m.addLayer({
        id: `${HL}-pt`,
        source: HL,
        type: 'circle',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 9, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': C.ink, 'circle-stroke-width': 3 },
      });
    } else {
      for (const id of [`${HL}-fill`, `${HL}-line`, `${HL}-pt`]) m.moveLayer(id);
    }
    installed.current = { layers: o.layers.map((l) => l.id), sources: [...sources] };
    setHighlight(latest.current.highlight);
  };

  const setHighlight = (g?: Geometry) => {
    const src = map.current?.getSource(HL) as GeoJSONSource | undefined;
    src?.setData({ type: 'FeatureCollection', features: g ? [{ type: 'Feature', geometry: g, properties: {} }] : [] });
  };

  // init
  useEffect(() => {
    const bm = BASEMAPS.find((b) => b.id === basemap)!;
    const m = new maplibregl.Map({
      container: el.current!,
      style: bm.style,
      center: camera.center,
      zoom: camera.zoom,
      pitch: camera.pitch ?? 0,
      bearing: camera.bearing ?? 0,
      attributionControl: { compact: true },
      maxPitch: 70,
    });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'top-right');
    m.on('style.load', () => {
      ready.current = true;
      installed.current = { layers: [], sources: [] };
      install();
    });
    m.on('mousemove', (e) => {
      const layers = installed.current.layers.filter((id) => m.getLayer(id));
      const hit = m.queryRenderedFeatures(e.point, { layers }).find((f) => f.properties?.key);
      m.getCanvas().style.cursor = hit ? 'pointer' : '';
      latest.current.onHoverKey(hit ? String(hit.properties.key) : null);
    });
    m.on('mouseout', () => latest.current.onHoverKey(null));
    m.on('click', (e) => {
      const layers = installed.current.layers.filter((id) => m.getLayer(id));
      const hit = m.queryRenderedFeatures(e.point, { layers }).find((f) => f.properties?.key);
      latest.current.onMapClick([e.lngLat.lng, e.lngLat.lat], hit ? String(hit.properties.key) : null);
    });
    return () => {
      ready.current = false;
      m.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // basemap swap
  const shownBasemap = useRef(basemap);
  useEffect(() => {
    if (shownBasemap.current === basemap) return;
    shownBasemap.current = basemap;
    const bm = BASEMAPS.find((b) => b.id === basemap)!;
    ready.current = false;
    map.current?.setStyle(bm.style, { diff: false });
  }, [basemap]);

  // scene / output change → reinstall layers
  useEffect(() => {
    install();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [output]);

  // camera only when the scene changes
  useEffect(() => {
    map.current?.easeTo({ ...camera, duration: 1400, essential: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneId]);

  // animation frame → push data
  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    const data = output.frame(t);
    for (const [id, d] of Object.entries(data)) {
      const src = m.getSource(id) as GeoJSONSource | undefined;
      src?.setData(d);
    }
  }, [t, output]);

  useEffect(() => setHighlight(highlight), [highlight]);

  return <div ref={el} className="map" role="region" aria-label="Map" />;
}
