#!/usr/bin/env bash
# Usage: ./run.sh <profile> <warehouse_id>
set -u
cd "$(dirname "$0")"
args=(); for f in sql/*.sql; do args+=(--file "$f"); done
databricks experimental aitools tools query "${args[@]}" --output json --warehouse "$2" --profile "$1" > results.json 2> run.err
python3 - <<'PY'
import json, glob
r = json.load(open('results.json'))
names = sorted(glob.glob('sql/*.sql'))
for n, x in zip(names, r):
    err = x.get('error'); rows = x.get('rows') or []
    print(f"{n[4:-4]:22} {str(x.get('state')):10} rows={len(rows):3}", ('ERR: ' + str(err)[:400]) if err else '')
PY
