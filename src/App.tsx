import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BASEMAPS, MapView, type BasemapId } from './MapView';
import { DEFAULT_PROBE, GROUPS, SCENES, type Row } from './scenes';
import { SqlPanel } from './Sql';
import { ResultTable } from './ResultTable';
import { Ecosystem } from './Ecosystem';

// ?capture: frame-accurate control for the promo-video footage script (promo/capture.mjs).
const captureMode = typeof window !== 'undefined' && new URLSearchParams(location.search).has('capture');
const reducedMotion = captureMode || (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const initialParams = () => Object.fromEntries(SCENES.map((s) => [s.id, Object.fromEntries(s.params.map((p) => [p.key, p.value]))]));

export default function App() {
  const [idx, setIdx] = useState(() => {
    const i = SCENES.findIndex((s) => s.id === location.hash.slice(1));
    return i >= 0 ? i : 0;
  });
  const scene = SCENES[idx];
  const [params, setParams] = useState<Record<string, Record<string, number>>>(initialParams);
  const [probe, setProbe] = useState<[number, number]>(DEFAULT_PROBE);
  const [selected, setSelected] = useState('clinic-0');
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(!reducedMotion);
  const [speed, setSpeed] = useState(1);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<BasemapId>('positron');
  const [toast, setToast] = useState<string | null>(null);
  const tRef = useRef(t);
  tRef.current = t;

  const p = params[scene.id];
  const ctx = useMemo(() => ({ probe, selected }), [probe, selected]);
  const output = useMemo(() => scene.build(p, ctx), [scene, p, ctx]);
  const clauses = useMemo(() => scene.sql(p, ctx), [scene, p, ctx]);
  const rows = useMemo(() => output.rows(t), [output, t]);
  const stats = useMemo(() => output.stats?.(t) ?? [], [output, t]);
  const activeStage = output.stages.reduce((a, s, i) => (t >= s.at ? i : a), 0);
  const finished = t >= 1;
  const highlight = useMemo(() => rows.find((r) => r.key === hoveredKey)?.geom, [rows, hoveredKey]);

  const replay = useCallback(() => {
    if (reducedMotion) {
      setT(1);
      return;
    }
    setT(0);
    setPlaying(true);
  }, []);

  // scene change
  useEffect(() => {
    history.replaceState(null, '', `#${scene.id}`);
    setHoveredKey(null);
    replay();
  }, [scene.id, replay]);

  // animation loop
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = Math.min(1, tRef.current + ((now - last) / scene.duration) * speed);
      last = now;
      setT(next);
      if (next >= 1) setPlaying(false);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, scene.duration, speed]);

  // capture hooks (no-op unless ?capture)
  useEffect(() => {
    if (!captureMode) return;
    document.documentElement.classList.add('capture');
    (window as unknown as { __demo: unknown }).__demo = {
      scenes: SCENES.map((s) => s.id),
      setScene: (id: string) => setIdx(SCENES.findIndex((s) => s.id === id)),
      setT: (v: number) => {
        setPlaying(false);
        setT(v);
      },
      setBasemap,
    };
  }, []);

  // keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowRight') setIdx((i) => Math.min(SCENES.length - 1, i + 1));
      else if (e.key === 'ArrowLeft') setIdx((i) => Math.max(0, i - 1));
      else if (e.key === 'r' || e.key === 'R') replay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [replay]);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1800);
  };

  const setParam = (key: string, value: number) => {
    setParams((prev) => ({ ...prev, [scene.id]: { ...prev[scene.id], [key]: value } }));
    setPlaying(false);
    setT(1);
  };

  const onMapClick = (lngLat: [number, number], key: string | null) => {
    if (scene.interaction === 'probe') {
      setProbe(lngLat);
      replay();
    } else if (scene.interaction === 'select' && key && !key.startsWith('fmt-')) {
      setSelected(key);
      replay();
    }
  };

  const onRowClick = (r: Row) => {
    if (scene.id === 'formats') {
      navigator.clipboard?.writeText(String(r.cells.output));
      flash(`Copied ${r.cells.function} output`);
    }
  };

  const exportGeoJSON = () => {
    const all = output.rows(1).filter((r) => r.geom);
    const gj = { type: 'FeatureCollection', features: all.map((r) => ({ type: 'Feature', geometry: r.geom, properties: r.cells })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(gj)], { type: 'application/geo+json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${scene.id}.geojson` });
    a.click();
    URL.revokeObjectURL(url);
    flash(`Downloaded ${all.length} features as ${scene.id}.geojson`);
  };

  const canExport = output.columns.length > 0 && scene.id !== 'formats';
  const bm = BASEMAPS.find((b) => b.id === basemap)!;

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden>
            <path d="M16 3 28 10v12L16 29 4 22V10z" fill="none" stroke="currentColor" strokeWidth="2.4" />
            <circle cx="16" cy="16" r="3.4" fill="#FF3621" />
          </svg>
          <div>
            <h1>Spatial SQL</h1>
            <p>on Databricks</p>
          </div>
        </div>
        <nav aria-label="Demo steps">
          {GROUPS.map((g) => (
            <div key={g} className="group">
              <h2>{g}</h2>
              <ol>
                {SCENES.map((s, i) =>
                  s.group === g ? (
                    <li key={s.id}>
                      <button className={i === idx ? 'step on' : 'step'} onClick={() => setIdx(i)} aria-current={i === idx ? 'step' : undefined}>
                        <span className="step-n">{i + 1}</span>
                        <span className="step-t">{s.title}</span>
                      </button>
                    </li>
                  ) : null,
                )}
              </ol>
            </div>
          ))}
        </nav>
        <div className="rail-foot">
          <p>
            Arrow keys change step, R replays.
            <br />
            All data is synthetic.
          </p>
          <a className="contact" href="https://www.linkedin.com/in/ashraf-osman-phd/" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path
                fill="currentColor"
                d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z"
              />
            </svg>
            <span>
              Ashraf Osman, PhD
              <small>Connect on LinkedIn</small>
            </span>
          </a>
        </div>
      </aside>

      <main className="stage">
        <MapView
          sceneId={scene.id}
          output={output}
          t={t}
          camera={scene.camera}
          basemap={basemap}
          highlight={highlight}
          onHoverKey={setHoveredKey}
          onMapClick={onMapClick}
        />

        {output.custom === 'ecosystem' && <Ecosystem />}

        {!output.custom && (
          <>
            <div className="basemaps" role="radiogroup" aria-label="Basemap">
              {BASEMAPS.map((b) => (
                <button key={b.id} role="radio" aria-checked={b.id === basemap} className={b.id === basemap ? 'on' : ''} onClick={() => setBasemap(b.id)}>
                  {b.label}
                </button>
              ))}
              <span className="provider">{bm.provider}</span>
            </div>

            {(scene.params.length > 0 || scene.hint) && (
              <div className="controls">
                {scene.params.map((pp) => (
                  <label key={pp.key} className="param">
                    <span className="param-l">
                      {pp.label}
                      <output>
                        {p[pp.key].toLocaleString()}
                        {pp.unit && ` ${pp.unit}`}
                      </output>
                    </span>
                    <input type="range" min={pp.min} max={pp.max} step={pp.step} value={p[pp.key]} onChange={(e) => setParam(pp.key, Number(e.target.value))} />
                  </label>
                ))}
                {scene.hint && <p className="hint">{scene.hint}</p>}
              </div>
            )}
          </>
        )}

        <div className="transport">
          <p className="caption" aria-live="polite">
            <span className="caption-step">
              {activeStage + 1}/{output.stages.length}
            </span>
            {output.stages[activeStage]?.caption}
          </p>
          <div className="transport-row">
            <button className="btn-run" onClick={() => (playing ? setPlaying(false) : finished ? replay() : setPlaying(true))}>
              {playing ? 'Pause' : finished ? 'Run again' : 'Resume'}
            </button>
            <input
              className="scrub"
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={t}
              aria-label="Animation progress"
              onChange={(e) => {
                setPlaying(false);
                setT(Number(e.target.value));
              }}
              style={{ ['--p' as string]: `${t * 100}%` }}
            />
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">
              <option value={0.5}>0.5×</option>
              <option value={1}>1×</option>
              <option value={2}>2×</option>
            </select>
          </div>
        </div>
        {toast && <div className="toast" role="status">{toast}</div>}
      </main>

      <section className="panel" aria-label="Explanation, SQL and results">
        <header className="panel-head">
          <h2>{scene.title}</h2>
          <ul className="fns" aria-label="Functions used">
            {scene.fns.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <p className="blurb">{scene.blurb}</p>
        </header>

        <div className="block">
          <div className="block-head">
            <h3>Query</h3>
            <span className="muted">Databricks SQL</span>
          </div>
          <SqlPanel clauses={clauses} active={activeStage} finished={finished} />
        </div>

        {output.columns.length > 0 && (
          <div className="block results">
            <div className="block-head">
              <h3>Result</h3>
              <span className="muted">{rows.length} rows</span>
              {canExport && (
                <button className="btn-ghost" onClick={exportGeoJSON}>
                  Download GeoJSON
                </button>
              )}
            </div>
            {stats.length > 0 && (
              <dl className="stats">
                {stats.map((s) => (
                  <div key={s.label}>
                    <dt>{s.label}</dt>
                    <dd>{s.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <ResultTable columns={output.columns} rows={rows} hoveredKey={hoveredKey} onHover={setHoveredKey} onRowClick={scene.id === 'formats' ? onRowClick : undefined} />
          </div>
        )}
      </section>
    </div>
  );
}
