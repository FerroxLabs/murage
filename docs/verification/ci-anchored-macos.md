# B3 packaged macOS anchored-reader gate

Implementation and Linux regression owner: ci-reds-ff3a-h.
EC2 Mac execution, signed package production and release decision owner: MAIN.

B3 remains open until MAIN records the native results below. Linux compilation
with SDK spelling adapters and fake filesystem positives do not qualify macOS.
The original rehearsal error lacked phase/errno; physical path canonicalization
is a candidate repair, not an established explanation of that failure.

## Pin the source and artifact

Run on an arm64 EC2 Mac with Xcode/CLT and Node 24/pnpm 10.33.0. Use a fresh
checkout of the full reviewed lane SHA containing this document, descended from
`a8a871520c1d1156646f85b149cd0eae1c1a7817`. MAIN sets these absolute paths and SHA:

```bash
set -euo pipefail
export REPO=/absolute/path/to/reviewed-checkout
export APP=/absolute/path/to/Murage.app
export EVIDENCE=/absolute/path/outside/checkout/b3-gate
export REVIEWED_SHA=FULL_REVIEWED_COMMIT_SHA
mkdir -p "$EVIDENCE"
cd "$REPO"
test "$(uname -m)" = arm64
test "$(git rev-parse HEAD)" = "$REVIEWED_SHA"
git merge-base --is-ancestor a8a871520c1d1156646f85b149cd0eae1c1a7817 HEAD
test -z "$(git status --porcelain)"
node --input-type=module -e 'import assert from "node:assert/strict"; assert.equal(process.platform,"darwin"); assert.equal(process.arch,"arm64"); assert.equal(process.versions.node.split(".")[0],"24");'
test "$(pnpm --version)" = 10.33.0
sw_vers > "$EVIDENCE/macos.txt"
xcodebuild -version > "$EVIDENCE/xcode.txt"
git rev-parse HEAD > "$EVIDENCE/source-sha.txt"
```

Build a fresh package from this SHA using the existing
`.github/workflows/package-mac-qualification.yml` preparation, GEPA metadata and
signing chain (or MAIN's equivalent approved EC2 Mac chain). Its required command
is unchanged:

```bash
pnpm exec electron-builder --mac dmg:arm64 zip:arm64 --publish never --config.extraMetadata.murageGepaManifests.darwin-arm64="$(node -p 'require("./qualification-evidence/gepa-package-metadata.json").extraMetadata.murageGepaManifests["darwin-arm64"]')"
```

Retain the complete preparation/package log and exit status in EVIDENCE. The
package step must print `PASS T-A12 packaged.anchoredAddonLoads darwin-arm64`
from the real afterPack call. Do not disable signing, afterPack, provenance,
anchoring, size, no-follow, volume, hard-link or mutation guards. Do not copy a
new addon into an old signed app. Signing credentials and keychains remain under
MAIN's existing runner procedure; none belong in the evidence or repository.
Run the workflow's remaining strict artifact, packaged server, minimum-OS,
notarization and stapling gates for release approval. T-A12 alone is B3 evidence,
not a replacement for those release gates.

## Prove the exact copied resource outside the checkout

APP must name the newly packaged arm64 app. The receipt is the build receipt
from that same package run. The following verifies the source/header receipt and
staged addon bytes and records the signed packaged hash before using the packaged executable, then runs the entire
native attack suite with that executable and copied addon. No live app is started.

```bash
export EXE="$APP/Contents/MacOS/Murage"
export ADDON="$APP/Contents/Resources/anchored-read.node"
export RECEIPT="$REPO/dist-native/anchored-read/darwin-arm64/build.json"
/usr/bin/lipo "$EXE" -verify_arch arm64
/usr/bin/lipo "$ADDON" -verify_arch arm64
/usr/bin/codesign --verify --deep --strict "$APP"
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const {REPO,EVIDENCE,ADDON,EXE,RECEIPT}=process.env;
const repo=fs.realpathSync(REPO), evidence=fs.realpathSync(EVIDENCE);
assert.ok(evidence !== repo && !evidence.startsWith(repo + path.sep), 'Evidence must be outside the checkout');
const hash=b=>createHash('sha256').update(b).digest('hex');
const receipt=JSON.parse(fs.readFileSync(RECEIPT));
assert.equal(receipt.version,1); assert.equal(receipt.target,'darwin-arm64');
assert.equal(receipt.napiVersion,9);
const source=['anchored-posix.c','common.h'].map(f=>fs.readFileSync(path.join(repo,'native/anchored-read',f),'utf8')).join('');
assert.equal(receipt.sourceSha256,hash(source));
assert.equal(receipt.nodeHeadersVersion,process.versions.node);
const headers=process.env.NODE_HEADERS_DIR || path.resolve(path.dirname(fs.realpathSync(process.execPath)),'../include/node');
for(const f of ['node_api.h','node_api_types.h','js_native_api.h','js_native_api_types.h','node_version.h']) assert.equal(receipt.headerSha256[f],hash(fs.readFileSync(path.join(headers,f))));
assert.equal(receipt.sha256,hash(fs.readFileSync(path.join(path.dirname(RECEIPT),'anchored-read.node'))));
fs.writeFileSync(path.join(evidence,'artifact.json'),JSON.stringify({sourceSha:process.env.REVIEWED_SHA,stagedAddonSha256:receipt.sha256,packagedAddonSha256:hash(fs.readFileSync(ADDON)),executableSha256:hash(fs.readFileSync(EXE)),receipt},null,2)+'\n');
NODE
# Signing changes Mach-O bytes. Bind the staged hash to the receipt and retain
# the fresh package/afterPack/signing log; record the signed resource separately.
cd "$EVIDENCE"
node --input-type=module <<'NODE' 2>&1 | tee "$EVIDENCE/packaged-ta12.log"
import {pathToFileURL} from 'node:url';
const {proveAnchoredReadResource}=await import(pathToFileURL(process.env.REPO+'/scripts/anchored-read-resource.mjs'));
console.log(proveAnchoredReadResource(process.env.ADDON,process.env.EXE));
NODE
ELECTRON_RUN_AS_NODE=1 "$EXE" "$REPO/scripts/prove-anchored-read.mjs" "$ADDON" "$EXE" 2>&1 | tee "$EVIDENCE/native-attacks.log"
```

Require exit 0 from both commands. The native log must contain T-A1, T-A2,
T-A3, T-A4, T-A7, T-A8, T-A9, T-A12 and
`PASS anchored-native darwin-arm64`. T-A5 is Windows-specific. The assertions
check exact fixture bytes and checkpoints, traversal/hard-link/symlink refusal,
swap/restore, FIFO, growth, size/name bounds and hook exception cleanup. Keep
logs on any failure; do not retry-wrap commands or change guards or timeouts.

## Historical probe and Linux diagnostic control

To distinguish native qualification from attribution of the original error,
replay the original probe against the same packaged executable/addon. This
copies only the historical JavaScript probe to EVIDENCE; the signed app is not
modified. A failure is retained as RED evidence; it never substitutes for the
candidate's required green commands above.

```bash
cd "$REPO"
git show af35e088eb6c9c0b058654bc064ee0923eeaf8fb:scripts/anchored-read-resource.mjs > "$EVIDENCE/historical-resource.mjs"
cd "$EVIDENCE"
node --input-type=module <<'NODE' > "$EVIDENCE/historical-ta12.log" 2>&1
import {pathToFileURL} from 'node:url';
import fs from 'node:fs';
const {proveAnchoredReadResource}=await import(pathToFileURL(process.env.EVIDENCE+'/historical-resource.mjs'));
try {
  console.log(proveAnchoredReadResource(process.env.ADDON,process.env.EXE));
  fs.writeFileSync('historical-result.json',JSON.stringify({refused:false})+'\n');
} catch(error) {
  console.error(error);
  fs.writeFileSync('historical-result.json',JSON.stringify({refused:true,code:error.code??null,status:error.status??null})+'\n');
}
NODE
```

Historical refusal plus candidate PASS may identify a probe-path difference.
If both pass, B3 native qualification can be green but the original failure is
not reproduced; report that explicitly. A generic error without the new native
phase/errno requires checking the receipt and exact artifact before diagnosis.
For a new refusal, retain `code`, `phase`, saved `errno` and native checkpoints;
`errno=0` denotes a semantic guard. Identify the failed operation before any
further implementation change. Escalate security/approval/privacy/data rulings
to MAIN in QUESTIONS-FOR-MAIN.md.

The Linux diagnostic regression compiles the actual C reader with SDK spelling
adapters, clobbers errno during close, and checks syscall and semantic failures
and pending exceptions. Restoring the exact `f83a69ff1833115b15fe32692cac3397ef057d42`
native reader must kill the new phase assertion. That RED/control pair is Linux
diagnostic evidence only, not a native macOS mutation kill or a packaged replay.
MAIN records the reviewed SHA, artifact hashes, all command statuses, positive
and refusal evidence, and the final B3/release decision in its handoff.
