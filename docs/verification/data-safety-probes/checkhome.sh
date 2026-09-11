#!/bin/bash
# checkhome.sh <fakehome> <label> — report any missing marker files
H=$1; L=$2
missing=0
while read -r f; do [ -e "$f" ] || { echo "MISSING [$L]: $f"; missing=1; }; done < "$H.manifest"
[ $missing -eq 0 ] && echo "INTACT [$L]: $(wc -l < "$H.manifest" | tr -d ' ') markers present"
