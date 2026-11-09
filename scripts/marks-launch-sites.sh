#!/usr/bin/env bash
# File tripwire. Per-engine D3-e/D3-f tests are the guarantee, not this scan.
set -euo pipefail
python3 - "${1:-.}" <<'PY'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
child = re.compile(r'''(?:from\s*|require\s*\(\s*|import\s*\(?\s*)['"](?:node:)?child_process['"]''')
receiver = re.compile(r'\.\s*(?:spawn|spawnSync|fork|execFile|execFileSync|execSync)\s*\(')
exec_receiver = re.compile(r'\b(?:cp|childProcess|child_process|deps|dependencies|spawner|this|process)\s*\.\s*exec\s*\(')
injected = re.compile(r'\b(?:fork|spawn|exec|execFile|forkFn|spawnFn|execFn|execFileFn|[A-Za-z_$][\w$]*(?:Fork|Spawn|Exec|Cli))\s*\??\s*(?::|=)|\bthis\.(?:forkFn|spawnFn|execFn|execFileFn)\b')
parameters = re.compile(r'[(,]\s*(?:fork|spawn|exec|execFile|forkFn|spawnFn|[A-Za-z_$][\w$]*(?:Fork|Spawn|Exec|Cli))\s*[,)]')
wrappers = re.compile(r'''(?:import|export)\s+[^;]*?\b(?:spawnCli|execCli|execCliSync)\b[^;]*?from\s*['"][^'"]*procs(?:\.ts)?['"]''')
for path in sorted((root / 'server').rglob('*')):
    if not path.is_file() or path.suffix not in ('.ts', '.tsx', '.js', '.mjs', '.cjs') or re.search(r'\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.ts$', path.name): continue
    text = path.read_text(errors='replace')
    if any(p.search(text) for p in (child, receiver, exec_receiver, injected, parameters, wrappers)):
        print(path.relative_to(root).as_posix())
PY
