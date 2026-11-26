#!/usr/bin/env bash
# digest.sh <db> : one line per table "<table> <rows> <sha16>" over every column, rows in full-column order (owner: q1023-cleanopus).
# Counts and digests only; never prints a row.
set -euo pipefail
db=${1:?}; U="file:$db?immutable=1"
for t in $(sqlite3 "$U" "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"); do
  nc=$(sqlite3 "$U" "SELECT count(*) FROM pragma_table_info('$t')")
  ord=$(seq -s, 1 "$nc")
  rows=$(sqlite3 "$U" "SELECT count(*) FROM \"$t\"")
  sha=$(sqlite3 -batch -csv "$U" "SELECT * FROM \"$t\" ORDER BY $ord" | sha256sum | cut -c1-16)
  echo "$t $rows $sha"
done
