# Avatar relay 6 verification

Started at `23e83409721461635757e3a486eedad020355003`. Base was
`a5450e2b532fdb4e66dc8aaf1a1c83f20422dc41`. Node was v24.21.0 and Vitest
was 4.1.10. No product code, checks, thresholds, or inventories changed in
this round. The supplied HEAD already fixes items 1 and 2 together; its
history was preserved. This commit records verification, not another fix.

## Items 1 and 2: existing fixes verified

An isolated worktree at HEAD's parent, `b7af68fe97`, reproduced both failures:

- `scripts/after-pack-windows-signing.test.mjs`: 12 failed, 10 passed. The
  missing file was `resources/server/browser-extension-panel-avatar-encoder.js`.
- `server/memory/learning-send-boundary.test.ts`, filtered to `every sink in
  server/`: one failed, 20 unselected. Its only unpinned sink was
  `server/browser-extension-panel-avatar.ts:84`, `encode`, `spawn`, the call
  to `fork(SPAWNED_PROXIES.panelAvatarEncoder, [], ...)`.

On the supplied HEAD, Windows signing passes 22/22 and the complete learning
boundary file passes 21/21. Commit `23e8340972` supplies the fixture worker
alongside the other required workers and pins the spawn's exact normalized
call text, function, file, and kind. The spawn starts a fixed local image
encoder with no prompt or learned payload in its arguments. The existing
`not-learning` classification applies to that spawn. No broad exemption or
inventory regeneration was added.

Searched `scripts/*.test.mjs` and `electron/*` for `after-pack`,
`validatePackagedMemoryRuntime`, and packaged server resource trees. Checked:

- `scripts/after-pack-windows-signing.test.mjs`: encoder fixture present.
- `scripts/after-pack-memory.test.mjs`: encoder fixture present, including
  the negative test that removes it and requires validation to fail.
- `scripts/after-pack.test.mjs`: CUA, cage and Fuigo partial fixtures call
  afterPack without a packager or memory manifest. The existing optional
  memory-runtime branch returns before worker validation; no missing worker.
- `scripts/stage-memory-model.test.mjs`: tests the model validator only.
- `scripts/packaged-prod-pin.test.mjs`: tests the production pin validator
  and inspects afterPack source; does not run full runtime validation.
- `scripts/release-gepa-receipts.test.mjs`: source checks, not a runtime tree.
- Electron has no afterPack caller. Its fake server resource trees in
  `backup-relaunch-tool-recovery.node-test.mjs`, `backup-start-race.test.mjs`
  and `backup-tool-capability.node-test.mjs` supply backup resolver modules
  for their own tests, not afterPack. The after-pack mentions in
  `backup-windows-acl.node-test.mjs` and
  `backup-remote-windows-spelling.node-test.mjs` are comments.

No additional fixture gap was found.

## Item 3: existing startup timing race reproduced on base

Three full runs of `server/after-listen.test.ts` on the supplied HEAD:

| Run | Result | Duration |
| --- | --- | --- |
| 1 | 9 passed | 13.12 s |
| 2 | 8 passed, listen-tick assertion failed | 12.34 s |
| 3 | 9 passed | 14.30 s |

The actual failure was not the leading memory log line. It was:

```text
[startup] writes before first health=1 at=waiting-epoch.ts:37<waiting-epoch.ts:45x1
```

Base was checked in an isolated worktree with the same dependencies. Five
full runs passed, then run 6 failed the same assertion with exactly that
write attribution (8 passed, 1 failed, 16.76 s). This is not a claim of three
clean HEAD runs or a lane-only regression.

`server/memory/waiting-monitor.ts` starts a 500 ms timer. Its first tick calls
`waitingEpoch`, whose lazy initialization executes schema writes at
`server/memory/waiting-epoch.ts:37`. The monitor starts before listen at
`server/index.ts:6075` (base line 6070). Those two memory modules and the
startup test are unchanged from base, as is the monitor's startup call.
Under a slow boot, that timer can fire between listen and the first health
answer. The deliberately blocked listen tick makes this observable.

The unchanged Git blobs are `e84ac8b0ce12694ada9a9429ff8bab974adbaaab`
for waiting-epoch and `b099cf7917aaceded36a6f2f79a54ae2c704c057` for
waiting-monitor, on both base and HEAD.

The lane adds imports, an empty avatar map, and helper closures before
listen; these do not perform avatar I/O or start an encoder. The pre-listen
initializer remains the first import. Production avatar construction is in
`browserExtensionRuntime`; helper creation only allocates state. The worker
fork and image reads happen on demand. Avatar refreshes are on request,
bind and status paths. No lane-added startup write was found. Startup code
and its assertions were left unchanged because base reproduces the cause.

## Item 4: owner-audience alone

`server/owner-audience.test.ts` passed all three separate invocations, each
9/9: 16.80 s, 13.79 s, 15.05 s. No other test file ran alongside it in this
checkout. Its source walkers stat names after readdir, which explains the
reported race with another test removing a temporary directory mid-walk.
The file is unchanged from base. No change was made.

## Commands and broader verification

`pnpm` is absent, so commands use `node_modules/.bin/vitest` and
`node_modules/.bin/tsc` directly. The memory prelude tool is unavailable and
`.ijfw/memory` is absent.

Initial commands:

```sh
node_modules/.bin/vitest run scripts/after-pack-windows-signing.test.mjs server/memory/learning-send-boundary.test.ts
node_modules/.bin/vitest run server/after-listen.test.ts
node_modules/.bin/vitest run server/owner-audience.test.ts
node_modules/.bin/vitest run scripts/after-pack-memory.test.mjs scripts/after-pack.test.mjs scripts/bundle-server-runtime-files.test.mjs server/proxy-paths.test.ts server/browser-extension-panel-avatar.test.ts server/browser-extension-avatar.test.ts
node --import ./server/testing/safe-wipe-preload.mjs --test scripts/browser-extension-x1.node-test.mjs scripts/browser-extension-idle.node-test.mjs extensions/murage-browser/sidepanel/sidepanel.node-test.mjs electron/proxy-launch-guard.node-test.mjs
node_modules/.bin/tsc -b
node_modules/.bin/tsc -p tsconfig.server.json
NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsc -p tsconfig.server.json
node scripts/ci-test-tiers.mjs check
```

The startup and owner commands were each invoked three times on HEAD.
Packaging/avatar Vitest files passed 91/91 across six files. The four Node
test files passed 121/121. App TypeScript passed. The first server TypeScript
attempt exhausted Node's default 4 GiB heap (exit 134); the 8 GiB retry passed
with exit 0. Tier inventory passed:
3475 files, 1988 gate and 1487 extended.

Followed `docs/verification/README.md` using the isolated launcher:

```sh
node --experimental-strip-types scripts/control-murage.ts launch
MURAGE_DATA_DIR=/tmp/murage-verify-data-tvcZWi node --experimental-strip-types scripts/control-murage.ts doctor --url http://127.0.0.1:22556
kill -INT 2169
```

The launcher reported child PID 2177 and log
`/tmp/murage-verification-evidence/server-1794008368635-2169.log`.
Doctor returned `ok: true`, connected health, and the available verification
engine. SIGINT stopped the exact launcher and cleaned its fixture. No live
application or user data was used. This proves fixture health, not a visual
avatar workflow.

Raw command output is in `/tmp/avatar-relay6/`. Before-fix checks used an
isolated worktree, never changes to the primary checkout.

## Final checks

After the successful type checks, reran the tier check (passed) and:

```sh
node_modules/.bin/vitest run scripts/after-pack-windows-signing.test.mjs server/memory/learning-send-boundary.test.ts server/after-listen.test.ts server/owner-audience.test.ts scripts/after-pack-memory.test.mjs scripts/after-pack.test.mjs scripts/bundle-server-runtime-files.test.mjs server/proxy-paths.test.ts server/browser-extension-panel-avatar.test.ts server/browser-extension-avatar.test.ts scripts/stage-memory-model.test.mjs scripts/packaged-prod-pin.test.mjs
node --import ./server/testing/safe-wipe-preload.mjs --test scripts/browser-extension-x1.node-test.mjs scripts/browser-extension-idle.node-test.mjs extensions/murage-browser/sidepanel/sidepanel.node-test.mjs electron/proxy-launch-guard.node-test.mjs
```

Final Vitest: 169 passed, 1 failed, across 12 files (209.78 s). The sole
failure is the same listen-tick assertion, again reporting
`writes before first health=1 at=waiting-epoch.ts:37<waiting-epoch.ts:45x1`.
All packaging, avatar, learning boundary, and owner-audience tests passed.
Final Node tests: 121 passed, none failed or skipped. No assertion was
weakened and no retry was used to replace the failing final result.

The temporary comparison worktree was removed after collecting its results.
Only this evidence report is added to the primary checkout.

Not run: the full 10-shard rig, native Windows signing, a built Electron
package, and an interactive browser avatar smoke test.
