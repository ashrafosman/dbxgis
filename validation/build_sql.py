"""Build read-only validation queries: each demo query verbatim, with ems.* tables
replaced by inline CTEs of synthetic rows. Nothing is written to the workspace."""
import pathlib, re

OUT = pathlib.Path(__file__).parent / "sql"
OUT.mkdir(exist_ok=True)
for f in OUT.glob("*.sql"):
    f.unlink()

SQ = '{"type":"Polygon","coordinates":[[[-86.20,39.74],[-86.12,39.74],[-86.12,39.80],[-86.20,39.80],[-86.20,39.74]]]}'
LW = '{"type":"Polygon","coordinates":[[[-86.12,39.80],[-86.00,39.80],[-86.00,39.88],[-86.12,39.88],[-86.12,39.80]]]}'
DEFS = f"""
raw_incidents_csv AS (
  SELECT * FROM VALUES
    ('INC-10001','Fall',-86.158D,39.768D), ('INC-10002','Cardiac',-86.11D,39.80D),
    ('INC-10003','Fall',-86.22D,39.755D),  ('INC-10004','Overdose',-86.12D,39.70D),
    ('INC-10005','Cardiac',-86.06D,39.845D), ('INC-10006','Cardiac',-86.175D,39.77D)
  AS t(incident_id, type, lon, lat)),
incidents AS (SELECT incident_id, type, lon, lat, ST_Point(lon, lat, 4326) AS geom FROM raw_incidents_csv),
clinics AS (SELECT name, ST_Point(x, y, 4326) AS geom FROM VALUES
    ('Downtown Health Center',-86.157D,39.771D), ('Riverside Clinic',-86.182D,39.758D),
    ('Eastside Clinic',-86.05D,39.775D) AS t(name, x, y)),
districts_geojson AS (SELECT * FROM VALUES ('Mile Square','{SQ}'), ('Lawrence','{LW}') AS t(name, geojson)),
districts AS (SELECT name, ST_GeomFromGeoJSON(geojson) AS geom FROM districts_geojson),
rivers AS (SELECT 'White River' AS name,
  ST_GeomFromText('LINESTRING(-86.07 39.875, -86.16 39.805, -86.185 39.745, -86.24 39.665)', 4326) AS geom),
boundaries AS (SELECT name, geom FROM districts),
incidents_h3 AS (SELECT incident_id, h3_longlatash3(lon, lat, 8) AS cell FROM raw_incidents_csv)
"""
TABLES = {
    "ems.raw.incidents_csv": "raw_incidents_csv", "ems.silver.incidents": "incidents",
    "ems.ref.clinics": "clinics", "ems.ref.districts_geojson": "districts_geojson",
    "ems.ref.districts": "districts", "ems.ref.rivers": "rivers",
    "ems.ref.boundaries": "boundaries", "ems.gold.incidents_h3": "incidents_h3",
}

def wrap(sql: str) -> str:
    for k, v in TABLES.items():
        sql = sql.replace(k, v)
    sql = sql.strip().rstrip(";")
    if re.match(r"(?is)^\s*WITH\s", sql):
        return "WITH " + DEFS.strip() + ",\n" + re.sub(r"(?is)^\s*WITH\s", "", sql, count=1)
    return "WITH " + DEFS.strip() + "\n" + sql

Q = {}
Q["00_transform_32616"] = "SELECT ST_AsText(ST_Transform(ST_Point(-86.15, 39.77, 4326), 32616)) AS utm, typeof(ST_Point(-86.15, 39.77, 4326)) AS t"
Q["01_st_point"] = """SELECT incident_id, type, lon, lat,
       ST_Point(lon, lat, 4326) AS geom
FROM   ems.raw.incidents_csv;"""
Q["02_area"] = """SELECT name,
  ST_GeomFromGeoJSON(geojson)            AS geom,
  ST_Transform(geom, 32616)              AS geom_utm,
  ST_Area(geom_utm) / 1e6                AS area_km2,
  ST_Perimeter(geom_utm) / 1e3           AS perimeter_km
FROM ems.ref.districts_geojson;"""
Q["03_buffer"] = """WITH zones AS (
  SELECT name,
    ST_Buffer(ST_Transform(geom, 32616), 1500) AS zone,
    ST_Area(zone) / 1e6                  AS zone_km2
  FROM ems.ref.clinics)
SELECT z.name, z.zone_km2,
       COUNT(i.incident_id)      AS incidents_within
FROM zones z LEFT JOIN ems.silver.incidents i
  ON ST_Contains(z.zone, ST_Transform(i.geom, 32616))
-- GEOMETRY is not groupable: group by scalar columns only
GROUP BY z.name, z.zone_km2 ORDER BY incidents_within DESC;"""
Q["04_join"] = """WITH d AS (
  SELECT name, geom,
         ST_Area(ST_Transform(geom, 32616)) / 1e6 AS area_km2
  FROM ems.ref.districts)
SELECT d.name AS district,
       COUNT(*)              AS incidents,
       COUNT(*) / d.area_km2 AS per_km2
FROM ems.silver.incidents i
JOIN d ON ST_Contains(d.geom, i.geom)
GROUP BY d.name, d.area_km2
ORDER BY incidents DESC;"""
Q["05_nearest"] = """WITH pairs AS (
  SELECT i.incident_id, c.name AS clinic,
         ST_DistanceSphere(i.geom, c.geom) AS dist_m
  FROM ems.silver.incidents i
  CROSS JOIN ems.ref.clinics c)
SELECT incident_id, clinic AS nearest_clinic, dist_m
FROM pairs
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY incident_id ORDER BY dist_m) = 1;"""
Q["06_dwithin"] = """SELECT incident_id, type,
  ST_DistanceSphere(geom, ST_Point(-86.1580, 39.7720, 4326))
                               AS dist_m
FROM ems.silver.incidents
WHERE ST_DWithin(ST_Transform(geom, 32616),
        ST_Transform(ST_Point(-86.1580, 39.7720, 4326), 32616), 1800)
ORDER BY dist_m;"""
Q["07_overlay"] = """WITH flood AS (
  SELECT ST_Buffer(ST_Transform(geom, 32616), 900) AS zone
  FROM ems.ref.rivers WHERE name = 'White River')
SELECT d.name,
  ST_Area(ST_Intersection(ST_Transform(d.geom, 32616), f.zone))
    / 1e6                          AS flooded_km2
FROM ems.ref.districts d CROSS JOIN flood f
WHERE ST_Intersects(ST_Transform(d.geom, 32616), f.zone);"""
Q["08_simplify"] = """SELECT name,
  ST_NPoints(geom)                         AS vertices_before,
  ST_NPoints(ST_Simplify(geom, 0.00225))   AS vertices_after
FROM ems.ref.boundaries;"""
Q["09_h3_agg"] = """SELECT cell,
       COUNT(*)               AS incidents,
       h3_boundaryaswkt(cell) AS hex_wkt
FROM (
  SELECT h3_longlatash3string(ST_X(geom), ST_Y(geom), 8) AS cell
  FROM ems.silver.incidents)
GROUP BY cell ORDER BY incidents DESC;"""
Q["10_kring"] = """WITH center AS (
  SELECT h3_longlatash3(-86.1580, 39.7720, 8) AS c),
rings AS (
  SELECT c, explode(h3_kring(c, 4)) AS cell FROM center)
SELECT h3_distance(c, cell)  AS ring,
       COUNT(DISTINCT cell)  AS cells,
       COUNT(i.incident_id)  AS incidents
FROM rings LEFT JOIN ems.gold.incidents_h3 i USING (cell)
GROUP BY ring ORDER BY ring;"""
Q["11_formats_point"] = """SELECT
  ST_AsText(geom)     AS wkt,
  ST_AsGeoJSON(geom)  AS geojson,
  ST_AsWKB(geom)      AS wkb,
  ST_AsEWKT(geom)     AS ewkt,
  ST_GeoHash(geom)    AS geohash
FROM ems.ref.clinics
WHERE name = 'Downtown Health Center';"""
Q["11b_formats_polygon"] = """SELECT
  ST_AsText(geom)     AS wkt,
  ST_AsGeoJSON(geom)  AS geojson,
  ST_AsWKB(geom)      AS wkb,
  ST_AsEWKT(geom)     AS ewkt
FROM ems.ref.districts
WHERE name = 'Mile Square';"""
Q["12_gold_select"] = """WITH counts AS (
  SELECT d.name, COUNT(i.incident_id) AS incidents
  FROM ems.ref.districts d
  LEFT JOIN ems.silver.incidents i ON ST_Contains(d.geom, i.geom)
  GROUP BY d.name)
SELECT d.name, c.incidents, d.geom,
       ST_AsWKB(d.geom)     AS wkb,
       ST_AsGeoJSON(d.geom) AS geojson
FROM ems.ref.districts d JOIN counts c USING (name);"""
Q["13_kepler"] = """SELECT h3_longlatash3string(ST_X(geom), ST_Y(geom), 8) AS hex_id,
       COUNT(*) AS incidents
FROM ems.silver.incidents
GROUP BY hex_id;"""
Q["14_bi_view_select"] = """SELECT incident_id, type,
       ST_Y(geom)     AS latitude,
       ST_X(geom)     AS longitude,
       ST_AsText(geom) AS wkt
FROM ems.silver.incidents;"""
Q["15_genie"] = """SELECT d.name, COUNT(*) AS cardiac_calls
FROM ems.silver.incidents i
JOIN ems.ref.districts d ON ST_Contains(d.geom, i.geom)
WHERE i.type = 'Cardiac'
  AND ST_DWithin(ST_Transform(i.geom, 32616),
                 (SELECT ST_Transform(geom, 32616) FROM ems.ref.rivers
                  WHERE name = 'White River'), 1000)
GROUP BY d.name ORDER BY cardiac_calls DESC;"""
Q["16_bi_hex_centers"] = """SELECT cell, h3_centeraswkt(cell) AS center_wkt, h3_boundaryaswkt(cell) AS boundary_wkt
FROM ems.gold.incidents_h3;"""

for name, sql in Q.items():
    body = sql if name.startswith("00_") else wrap(sql)
    (OUT / f"{name}.sql").write_text(body + "\n")
print(len(Q), "queries written to", OUT)
