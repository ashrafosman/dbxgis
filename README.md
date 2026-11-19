# Spatial SQL on Databricks — interactive field guide

A local, click-through demo of Databricks geospatial: native `GEOMETRY` types, `ST_*` spatial SQL,
H3 indexing, and how Databricks connects to the rest of the GIS stack.

Each step pairs **real Databricks SQL** with a **map animation** and a **live result table**:
the SQL clause currently "executing" lights up as the map animates, and table rows and map
features are linked (hover either one to highlight the other).

All data is synthetic (EMS incidents, clinics, districts, a river around Indianapolis). The spatial
math runs in the browser with Turf.js and h3-js to mirror what the SQL would return, so no workspace is needed.

**Live demo:** https://ashrafosman.github.io/dbxgis/

## Run

```bash
bun install        # or npm install
bun run dev        # http://localhost:5180
bun run build      # static bundle in dist/
```

## Steps

| # | Step | Functions |
|---|------|-----------|
| 1 | Turn coordinates into geometry | `ST_Point`, `GEOMETRY(4326)` |
| 2 | Load polygons and measure them | `ST_GeomFromGeoJSON`, `ST_Transform`, `ST_Area`, `ST_Perimeter` |
| 3 | Draw service areas with a buffer | `ST_Buffer`, `ST_Contains` (radius slider) |
| 4 | Spatial join | `ST_Contains` + `GROUP BY` (animated scan + choropleth) |
| 5 | Find the nearest clinic | `ST_DistanceSphere`, `QUALIFY ROW_NUMBER()` |
| 6 | Search around any point | `ST_DWithin` (click the map to move the probe) |
| 7 | Overlay a flood zone | `ST_Buffer`, `ST_Intersects`, `ST_Intersection` |
| 8 | Simplify detailed shapes | `ST_Simplify`, `ST_NPoints` |
| 9 | Aggregate into H3 hexagons | `h3_longlatash3string`, `h3_boundaryaswkt` (3D, resolution slider) |
| 10 | Expand rings of neighbours | `h3_kring`, `h3_distance` (click to pick centre) |
| 11 | Fill polygons with H3 cells | `h3_polyfillash3` vs `h3_tessellateaswkb` (core cells + clipped chips; click a district) |
| 12 | Speak every GIS format | `ST_AsText`, `ST_AsGeoJSON`, `ST_AsWKB`, `ST_AsEWKT`, `ST_GeoHash` |
| 13 | Plug into the GIS stack | Ingest (GeoJSON, Shapefile, GeoParquet, Esri, PostGIS, streams) → serve (ArcGIS, QGIS, GeoPandas, Kepler/deck.gl, Power BI/Tableau, AI/BI + Genie) |

## Presenter controls

- Arrow keys ← / → change step, **R** replays the animation.
- Drag the progress bar to scrub through the query stages; 0.5× / 1× / 2× speed.
- Basemap switcher: CARTO vector (Light / Streets / Dark), OpenStreetMap raster, Esri World Imagery.
  This shows that the same layers sit on any provider's tiles.
- **Download GeoJSON** exports the current result. Drop it into QGIS, ArcGIS Online or geojson.io.
- Deep-link a step with its hash, e.g. `http://localhost:5180/#h3-agg`.

Basemap tiles need internet access; everything else runs offline.

## Validating the SQL against a workspace

`validation/` re-runs every demo query, word for word, against a SQL warehouse. The `ems.*` tables
are replaced by inline CTEs of synthetic rows, so the run is read-only and creates nothing.

```bash
python3 validation/build_sql.py                 # writes validation/sql/*.sql
./validation/run.sh <profile> <warehouse_id>    # prints SUCCEEDED / error per query
```

Last run: all 19 queries succeeded (Azure workspace, serverless SQL warehouse, 2026-11-17).
