#!/usr/bin/env bash
# Host-only release runner. No provider, login, paid engine, or network access.
set -euo pipefail
exec python3 - "$@" <<'PY'
import concurrent.futures, hashlib, json, os, pathlib, re, shutil, signal, subprocess, sys, threading

# MAIN RULING 1115-PUB-HYGIENE: build-host paths come from the environment, not the tree.
def host_env(name):
    value = os.environ.get(name)
    if not value:
        sys.exit('set ' + name)
    return value

SMALL = pathlib.Path(host_env('GNL_SMALL'))
PRIVATE = pathlib.Path(host_env('GNL_PRIVATE'))

def require(ok, message):
    if not ok:
        raise SystemExit(message)

require(len(sys.argv) == 3, 'Usage: gnl-hz-release.sh <40-hex commit> <tag>')
sha, tag = sys.argv[1:]
require(re.fullmatch('[a-f0-9]{40}', sha), 'A full commit SHA is required')
require(re.fullmatch('[A-Za-z0-9_-]+', tag), 'Invalid run tag')
require(os.environ.get('GNL_CORPUS_HOST') == str(PRIVATE), 'GNL_CORPUS_HOST must name the approved complete bundle')
pin = os.environ.get('GNL_CORPUS_SHA256', '')
require(re.fullmatch('[a-f0-9]{64}', pin), 'Independently reviewed LABEL seal required')
require(os.environ.get('GNL_CORPUS_SELFHASH', '0') == '0', 'Self-hashing is not release admission')
# Compare only the independently supplied seal; never derive an approval pin.
require(pin == (PRIVATE / 'labels-v1.sha256').read_text().split()[0], 'Reviewed LABEL seal mismatch')
k = int(os.environ.get('GNL_SHARDS', '4'))
workers = int(os.environ.get('GNL_MAX_CONTAINERS', '4'))
require(1 <= k <= 23 and 1 <= workers <= 4, 'Use 1..23 shards and at most four concurrent containers')
run = pathlib.Path(os.environ.get('RUN', str(SMALL / ('gnl-' + tag))))
require(run.is_absolute() and run.parent == SMALL and run.name.startswith('gnl-'), 'RUN must be a new _small/gnl-* directory')
require(not run.exists(), 'RUN already exists; preserve existing evidence and choose a new tag')
git_dir = host_env('G')
subprocess.run(['git', '--git-dir=' + git_dir, 'cat-file', '-e', sha + '^{commit}'], check=True)
run.mkdir(mode=0o700)
src, out = run / 'src', run / 'out'
src.mkdir(); out.mkdir()
try:
    archive = subprocess.Popen(['git', '--git-dir=' + git_dir, 'archive', sha], stdout=subprocess.PIPE)
    unpack = subprocess.run(['tar', '-x', '-C', str(src)], stdin=archive.stdout)
    archive.stdout.close()
    require(archive.wait() == 0 and unpack.returncode == 0, 'Commit archive failed')
    with (src / 'server/testing/.git-ls-files.fixture').open('wb') as listing:
        subprocess.run(['git', '--git-dir=' + git_dir, 'ls-tree', '-r', '-z', '--name-only', sha], stdout=listing, check=True)
    tools, host = pathlib.Path(host_env('GNL_TOOLS')), pathlib.Path(host_env('GNL_HOST'))
    lock = hashlib.sha256((src / 'pnpm-lock.yaml').read_bytes()).hexdigest()[:16]
    cage_key = hashlib.sha256((src / 'scripts/build-murage-cage.mjs').read_bytes() + (src / 'scripts/prepare-source-cage.mjs').read_bytes()).hexdigest()[:16]
    nm, cage = (tools / 'nm' / lock / 'node_modules').resolve(), tools / 'cage' / cage_key
    require(nm.is_dir() and (cage / 'linux-x64/bwrap').is_file(), 'Shared dependency/cage caches are not ready')
    inner = '''set -euo pipefail
mkdir -p /tmp/home
cp -a /src/. /work/
mkdir -p /work/node_modules
for f in /nm/* /nm/.[!.]*; do
  case "$f" in */.vite-temp|*/.vite|*/.cache) ;; *) ln -s "$f" /work/node_modules/;; esac
done
export PATH=/tools/bin:$PATH NODE_OPTIONS=--max-old-space-size=12000
chmod +x scripts/no-limits-live/fakes/*.mjs
node scripts/no-limits-live/release-engines.mjs /work/engines.json
exec node --experimental-strip-types scripts/no-limits-live/run.mjs --live --release --platform linux --candidate "$GNL_CANDIDATE" --engines-file /work/engines.json --shard "$GNL_SHARD" --shards "$GNL_SHARDS" --corpus "$GNL_CORPUS_HOST" --corpus-sha256 "$GNL_CORPUS_SHA256" --out "/out/gnl-$GNL_SHARD"
'''
    active, lock, interrupted = set(), threading.Lock(), threading.Event()
    def stop_owned(signum, frame):
        interrupted.set()
        with lock: names = list(active)
        for name in names:
            subprocess.run(['docker', 'stop', '--time', '5', name], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    signal.signal(signal.SIGINT, stop_owned)
    signal.signal(signal.SIGTERM, stop_owned)
    def shard(i):
        if interrupted.is_set(): return i, 130
        name = 'gnl-' + tag + '-s' + str(i)
        # UID 0 is required to READ the root-owned 0700/0600 private bundle.
        # Its only private mount is read-only at the exact allowlisted path.
        args = ['docker', 'run', '--pull', 'never', '--rm', '--init', '--name', name,
                '--user', '0:0', '--cpus', os.environ.get('CPUS', '3'), '--memory', os.environ.get('MEM', '12g'),
                '--network', 'none', '--label', 'owner=gnl-harness-r4', '--label', 'purpose=gnl-release-leg',
                '--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined', '--security-opt', 'systempaths=unconfined',
                '--tmpfs', '/work:rw,exec,size=4g,mode=0755', '--tmpfs', '/home:rw,mode=0755']
        env = dict(HOME='/tmp/home', CI='1', NO_COLOR='1', ELECTRON_SKIP_BINARY_DOWNLOAD='1', MURAGE_SKIP_REAL_ELECTRON_BROWSER_FIXTURE='1', MURAGE_BACKUP_TEST_AGE_DIR='/runtime/age',
                   GNL_CANDIDATE=sha, GNL_SHARD=str(i), GNL_SHARDS=str(k), GNL_CORPUS_HOST=str(PRIVATE), GNL_CORPUS_SHA256=pin)
        for key, value in env.items():
            args += ['-e', key + '=' + value]
        for source, target in [(src, '/src'), (nm, '/nm'), (cage, '/work/dist-native/cage'), (PRIVATE, str(PRIVATE)),
                               (host / 'tools', '/tools'), (host / 'runtime', '/runtime')]:
            args += ['--mount', 'type=bind,src=' + str(source) + ',dst=' + target + ',readonly']
        args += ['--mount', 'type=bind,src=' + str(out) + ',dst=/out', '-w', '/work', 'node:24-bookworm', 'bash', '-c', inner]
        with lock: active.add(name)
        try:
            with (run / ('gnl-' + str(i) + '.log')).open('w') as log:
                rc = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT).returncode
        finally:
            with lock: active.discard(name)
        (run / ('shard-' + str(i) + '.rc')).write_text(str(rc) + '\n')
        return i, rc
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        codes = dict(pool.map(shard, range(k)))
    # Each owned-engine verdict and process exit is binding. Never filter out
    # failed cells or subtract mandatory failures while merging.
    engines, errors, rows = set(), [], 0
    for i in range(k):
        try:
            v = json.loads((out / ('gnl-' + str(i)) / 'verdict.json').read_text())
            owned = v['ownedEngines']
            require(len(owned) == len(set(owned)) and not engines.intersection(owned), 'Duplicate engine ownership')
            engines.update(owned)
            if codes[i] != 0 or v['verdict'] != 'PASS': errors.append('shard-' + str(i) + ':FAIL')
            if {e['id'] for e in v['engines']} != set(owned) or any(r['engine'] not in owned for r in v['rows']): errors.append('shard-' + str(i) + ':ownership')
            rows += len(v['rows'])
        except (KeyError, ValueError, OSError): errors.append('shard-' + str(i) + ':missing-verdict')
    if len(engines) != 23: errors.append('incomplete-engine-catalogue')
    report = dict(verdict='FAIL' if errors else 'PASS', shards=k, engines=len(engines), rows=rows, errors=errors)
    (run / 'merged.json').write_text(json.dumps(report, indent=2) + '\n')
    rc = 1 if errors else 0
    (run / 'GNL.rc').write_text(str(rc) + '\n')
    print('GNL-MERGED ' + json.dumps(report))
finally:
    # Only this new snapshot is disposable; logs and count-only replay evidence stay.
    shutil.rmtree(src)
sys.exit(rc)
PY
