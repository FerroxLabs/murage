#!/usr/bin/env bash
# R16-d measured set: named verdict readers union direct module importers.
set -euo pipefail
python3 - "${1:-.}" <<'PY'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
names = re.compile(r'\b(?:alwaysAskCommand|alwaysAskRoutineCommand|autoVerdict)\b')
imports = re.compile(r'''(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"]([^'"]+)['"]''')
modules = {'index', 'approvals', 'auto-approve', 'always-ask'}
for path in sorted((root / 'server').rglob('*.test.ts')):
    text = path.read_text(errors='replace')
    direct = False
    for match in imports.finditer(text):
        target = match.group(1)
        if target.startswith('.'):
            resolved = (path.parent / target).resolve()
            if resolved.stem in modules and resolved.is_relative_to((root / 'server').resolve()): direct = True
    if names.search(text) or direct: print(path.relative_to(root).as_posix())
PY
