#!/usr/bin/env python3
"""Generate inert Unicode name data for Python string escapes; never read payloads."""
import json
import pathlib
import unicodedata

assert unicodedata.unidata_version == "15.0.0", "Use the reference Python Unicode version"
root = pathlib.Path(__file__).resolve().parents[1]
names, ideographs = {}, {}
for cp in range(0x110000):
    name = unicodedata.name(chr(cp), '')
    if not name:
        continue
    if name.startswith(('CJK UNIFIED IDEOGRAPH-', 'CJK COMPATIBILITY IDEOGRAPH-')):
        prefix = name.rsplit('-', 1)[0]
        ranges = ideographs.setdefault(prefix, [])
        if ranges and ranges[-1][1] == cp - 1:
            ranges[-1][1] = cp
        else:
            ranges.append([cp, cp])
    else:
        names[name] = chr(cp)
for name in (root / 'scripts/python-unicode-aliases.txt').read_text().splitlines():
    if name and not name.startswith('#'):
        names[name] = unicodedata.lookup(name)
path = root / 'server/python-unicode-names.json'
path.write_text(json.dumps({'version': unicodedata.unidata_version, 'ideographs': ideographs, 'names': names}, ensure_ascii=True, indent=2) + '\n')
