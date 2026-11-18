import { useState } from 'react';
import { highlightSql } from './Sql';

type Node = { id: string; label: string; side: 'in' | 'out'; how: string; lang: 'sql' | 'python'; code: string };

const NODES: Node[] = [
  {
    id: 'files',
    label: 'GeoJSON & WKT files',
    side: 'in',
    how: 'Drop files in a Unity Catalog volume and parse them in SQL. Auto Loader picks up new files as they arrive.',
    lang: 'sql',
    code: `SELECT feat.properties.name                    AS name,
       ST_GeomFromGeoJSON(to_json(feat.geometry)) AS geom
FROM (SELECT explode(features) AS feat
      FROM read_files('/Volumes/ems/raw/geo/districts.geojson',
                      format => 'json', multiLine => true));`,
  },
  {
    id: 'shp',
    label: 'Shapefile & GeoPackage',
    side: 'in',
    how: 'Read with GeoPandas or GDAL in a notebook, hand the geometry over as WKB, and store it as a native GEOMETRY column.',
    lang: 'python',
    code: `import geopandas as gpd
gdf = gpd.read_file("/Volumes/ems/raw/geo/parcels.shp").to_crs(4326)
gdf["wkb"] = gdf.geometry.to_wkb()
(spark.createDataFrame(gdf.drop(columns="geometry"))
     .selectExpr("*", "ST_GeomFromWKB(wkb, 4326) AS geom")
     .write.saveAsTable("ems.ref.parcels"))`,
  },
  {
    id: 'parquet',
    label: 'GeoParquet',
    side: 'in',
    how: 'GeoParquet stores geometry as WKB, so one function call turns it into GEOMETRY.',
    lang: 'sql',
    code: `CREATE TABLE ems.ref.roads AS
SELECT * EXCEPT (geometry),
       ST_GeomFromWKB(geometry, 4326) AS geom
FROM read_files('/Volumes/ems/raw/geo/roads/*.parquet');`,
  },
  {
    id: 'esri-in',
    label: 'Esri feature services',
    side: 'in',
    how: 'Schedule a Lakeflow job that pages through an ArcGIS REST layer as GeoJSON. For heavy analytics, Esri’s ArcGIS GeoAnalytics Engine also runs on Databricks compute.',
    lang: 'python',
    code: `import requests, json
url = "https://services.arcgis.com/<org>/arcgis/rest/services/Hospitals/FeatureServer/0/query"
fc = requests.get(url, params={"where": "1=1", "outFields": "*", "f": "geojson"}).json()
rows = [(f["properties"]["NAME"], json.dumps(f["geometry"])) for f in fc["features"]]
(spark.createDataFrame(rows, "name string, gj string")
     .selectExpr("name", "ST_GeomFromGeoJSON(gj) AS geom")
     .write.mode("overwrite").saveAsTable("ems.ref.hospitals"))`,
  },
  {
    id: 'postgis',
    label: 'PostGIS',
    side: 'in',
    how: 'Lakehouse Federation queries PostGIS in place (read-only), without copying. PostGIS geometry columns arrive as BINARY, so expose plain WKB with ST_AsBinary in a Postgres view and rebuild it with ST_GeomFromWKB.',
    lang: 'sql',
    code: `CREATE CONNECTION postgis_conn TYPE postgresql
  OPTIONS (host 'gis-db.internal', port '5432',
           user secret('gis', 'user'), password secret('gis', 'pw'));
CREATE FOREIGN CATALOG gis_pg USING CONNECTION postgis_conn
  OPTIONS (database 'gis');

SELECT name, ST_GeomFromWKB(geom_wkb, 4326) AS geom
FROM gis_pg.public.service_areas_v;`,
  },
  {
    id: 'stream',
    label: 'GPS & IoT streams',
    side: 'in',
    how: 'Ambulance pings stream in and get a geometry plus an H3 cell as they land, so live maps refresh every few seconds.',
    lang: 'sql',
    code: `CREATE OR REFRESH STREAMING TABLE ems.silver.unit_pings AS
SELECT unit_id, event_ts,
       ST_Point(lon, lat, 4326)          AS geom,
       h3_longlatash3(lon, lat, 9)       AS cell
FROM STREAM ems.raw.unit_pings;`,
  },
  {
    id: 'arcgis',
    label: 'ArcGIS Online & Enterprise',
    side: 'out',
    how: 'Esri’s ArcGIS GeoAnalytics Engine runs on Databricks compute. To share results, publish them as hosted feature layers with the ArcGIS API for Python. ArcGIS Pro query layers don’t list Databricks as a supported cloud warehouse yet, so the hand-off is through files or hosted layers.',
    lang: 'python',
    code: `from arcgis.gis import GIS
import geopandas as gpd
pdf = spark.sql("""SELECT name, incidents, ST_AsWKB(geom) AS wkb
                   FROM ems.gold.district_load""").toPandas()
gdf = gpd.GeoDataFrame(pdf.drop(columns="wkb"),
                       geometry=gpd.GeoSeries.from_wkb(pdf.wkb), crs=4326)
gdf.to_file("/tmp/district_load.geojson", driver="GeoJSON")

from arcgis.gis import ItemProperties, ItemTypeEnum
gis = GIS("https://<org>.maps.arcgis.com", api_key=dbutils.secrets.get("gis", "arcgis"))
folder = gis.content.folders.get()            # root folder
item = folder.add(
    item_properties=ItemProperties(title="District load", item_type=ItemTypeEnum.GEOJSON),
    file="/tmp/district_load.geojson").result()
item.publish()   # hosted feature layer for ArcGIS Online / Pro`,
  },
  {
    id: 'qgis',
    label: 'QGIS',
    side: 'out',
    how: 'Pull results through the Databricks SQL connector and write a GeoPackage, or load WKT columns directly as a delimited-text layer.',
    lang: 'python',
    code: `from databricks import sql
import geopandas as gpd, pandas as pd
with sql.connect(server_hostname=HOST, http_path=HTTP_PATH,
                 credentials_provider=oauth) as c:
    df = pd.read_sql("SELECT name, incidents, ST_AsText(geom) AS wkt "
                     "FROM ems.gold.district_load", c)
gpd.GeoDataFrame(df, geometry=gpd.GeoSeries.from_wkt(df.wkt), crs=4326) \\
   .to_file("district_load.gpkg")   # open in QGIS`,
  },
  {
    id: 'python',
    label: 'GeoPandas & Shapely',
    side: 'out',
    how: 'Data scientists keep their usual Python stack. WKB moves between Spark and GeoPandas without loss.',
    lang: 'python',
    code: `pdf = spark.sql("""SELECT name, ST_AsWKB(geom) AS wkb
                   FROM ems.ref.districts""").toPandas()
gdf = gpd.GeoDataFrame(pdf, geometry=gpd.GeoSeries.from_wkb(pdf.wkb), crs=4326)
gdf.explore(column="name")   # folium map in the notebook`,
  },
  {
    id: 'web',
    label: 'Kepler.gl, deck.gl & MapLibre',
    side: 'out',
    how: 'Web maps read GeoJSON or H3 cell IDs straight from a SQL warehouse. This demo is built on that pattern and can ship as a Databricks App.',
    lang: 'sql',
    code: `-- Kepler.gl and deck.gl render H3 cell IDs natively
SELECT h3_longlatash3string(ST_X(geom), ST_Y(geom), 8) AS hex_id,
       COUNT(*) AS incidents
FROM ems.silver.incidents
GROUP BY hex_id;`,
  },
  {
    id: 'bi',
    label: 'Power BI & Tableau',
    side: 'out',
    how: 'Connect with the native Databricks connectors (DirectQuery / live). Power BI maps work best from latitude/longitude columns. Tableau can build points with MAKEPOINT or shapes from WKT with PARSE_WKT.',
    lang: 'sql',
    code: `CREATE VIEW ems.gold.bi_incidents AS
SELECT incident_id, type,
       ST_Y(geom)     AS latitude,    -- Power BI / Azure Maps
       ST_X(geom)     AS longitude,
       ST_AsText(geom) AS wkt         -- Tableau: PARSE_WKT([wkt])
FROM ems.silver.incidents;`,
  },
  {
    id: 'aibi',
    label: 'AI/BI dashboards & Genie',
    side: 'out',
    how: 'AI/BI dashboards draw point maps and choropleths straight from GEOMETRY columns. Genie turns plain-English questions into spatial SQL. Add instructions and example queries to the Genie Agent so it knows which geometry columns and predicates to use.',
    lang: 'sql',
    code: `-- Genie: "Which districts had the most cardiac calls
--          within 1 km of the river last month?"
SELECT d.name, COUNT(*) AS cardiac_calls
FROM ems.silver.incidents i
JOIN ems.ref.districts d ON ST_Contains(d.geom, i.geom)
WHERE i.type = 'Cardiac'
  AND ST_DWithin(ST_Transform(i.geom, 32616),
                 (SELECT ST_Transform(geom, 32616) FROM ems.ref.rivers
                  WHERE name = 'White River'), 1000)
GROUP BY d.name ORDER BY cardiac_calls DESC;`,
  },
];

const W = 1000;
const H = 560;
const ROW = (i: number, n: number) => 70 + (i * (H - 140)) / (n - 1);
const HUB = { x: 380, y: 150, w: 240, h: 260 };

export function Ecosystem() {
  const [sel, setSel] = useState<string>('arcgis');
  const ins = NODES.filter((n) => n.side === 'in');
  const outs = NODES.filter((n) => n.side === 'out');
  const node = NODES.find((n) => n.id === sel)!;

  const pathFor = (n: Node, i: number, count: number) => {
    const y = ROW(i, count);
    if (n.side === 'in') {
      const x1 = 232;
      const x2 = HUB.x;
      const y2 = HUB.y + 40 + (i * (HUB.h - 80)) / (count - 1);
      return `M${x1},${y} C${x1 + 90},${y} ${x2 - 90},${y2} ${x2},${y2}`;
    }
    const x1 = HUB.x + HUB.w;
    const y1 = HUB.y + 40 + (i * (HUB.h - 80)) / (count - 1);
    const x2 = 768;
    return `M${x1},${y1} C${x1 + 90},${y1} ${x2 - 90},${y} ${x2},${y}`;
  };

  const renderSide = (list: Node[]) =>
    list.map((n, i) => {
      const y = ROW(i, list.length);
      const x = n.side === 'in' ? 10 : 768;
      const d = pathFor(n, i, list.length);
      const pid = `p-${n.id}`;
      const on = sel === n.id;
      return (
        <g key={n.id}>
          <path id={pid} d={d} className={`eco-link ${on ? 'on' : ''}`} />
          <circle r={on ? 5 : 3.5} className={`packet ${on ? 'on' : ''}`}>
            <animateMotion dur={`${2.4 + (i % 3) * 0.5}s`} repeatCount="indefinite" begin={`${i * 0.35}s`}>
              <mpath href={`#${pid}`} />
            </animateMotion>
          </circle>
          <g
            className={`eco-node ${on ? 'on' : ''}`}
            transform={`translate(${x},${y - 20})`}
            onClick={() => setSel(n.id)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setSel(n.id)}
            tabIndex={0}
            role="button"
            aria-pressed={on}
          >
            <rect width={222} height={40} rx={6} />
            <text x={14} y={25}>{n.label}</text>
          </g>
        </g>
      );
    });

  return (
    <div className="eco">
      <svg viewBox={`0 0 ${W} ${H}`} className="eco-svg" role="img" aria-label="How Databricks connects to the GIS ecosystem">
        <text x={10} y={30} className="eco-col">Bring data in</text>
        <text x={768} y={30} className="eco-col">Use it anywhere</text>
        {renderSide(ins)}
        {renderSide(outs)}
        <g className="eco-hub" transform={`translate(${HUB.x},${HUB.y})`}>
          <rect width={HUB.w} height={HUB.h} rx={10} />
          <text x={20} y={38} className="hub-title">Databricks</text>
          <text x={20} y={58} className="hub-sub">Data Intelligence Platform</text>
          {[
            ['Delta & Iceberg tables', 'GEOMETRY / GEOGRAPHY columns'],
            ['Spatial SQL + H3', 'ST_ functions on Photon'],
            ['Unity Catalog', 'access, lineage, sharing'],
          ].map(([a, b], i) => (
            <g key={a} transform={`translate(20,${86 + i * 56})`}>
              <rect width={HUB.w - 40} height={46} rx={5} className="hub-layer" />
              <text x={12} y={20} className="hub-a">{a}</text>
              <text x={12} y={36} className="hub-b">{b}</text>
            </g>
          ))}
        </g>
      </svg>
      <div className="eco-detail" aria-live="polite">
        <h3>{node.label}</h3>
        <p>{node.how}</p>
        <pre className={`snippet lang-${node.lang}`}>
          {node.code.split('\n').map((l, i) => (
            <div key={i}>{node.lang === 'sql' ? highlightSql(l) : l}</div>
          ))}
        </pre>
      </div>
    </div>
  );
}
