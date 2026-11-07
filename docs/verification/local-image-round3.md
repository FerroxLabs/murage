# Local image queue cancellation correction

Base: `722d199e36e727e6407b58de60b2c67ffa905bc1`.

Queue cancellation now carries a private symbol through the queue. The caller
still receives unavailable/unanswered, but cancellation returns before the
canonical publication gate. No discovery ran, so another subscribed alias
keeps its ready result and receives no notification.

## Red proof

Before changing production code, ran:

```
node_modules/.bin/vitest run src/lib/media-resolve.test.ts -t 'cancelled queued retry'
```

Vitest failed: 1 failed, 45 skipped. Three soft assertions failed: B received
unavailable instead of its identical ready object, B was notified on cancellation,
and B had two notifications after the later real listing failure instead of one.
The test also proved four active blockers, one queued retry, no discovery calls
for the cancelled retry, and actual root/list calls for the later failure.
Log: `/tmp/local-image-round3-red.log`.

## Publication outcome audit

This audit covers the final publication gate in `run`, before committing.
Publication requires an attached entry, an unavailable result and a result not
already stored on that entry.

| Outcome reaching the gate | Real discovery answer? | Behavior |
| --- | --- | --- |
| Queue cancellation symbol | No, discovery never ran | Return unavailable to caller without publication |
| unavailable/outside | Root reports no dedicated workspace, or local path eligibility rejects the path | Publish refusal |
| unavailable/remote | Yes, root reports remote | Publish refusal |
| unavailable/not-listed | Yes, completed listings or wrong entry kinds establish no eligible file in candidate paths | Publish refusal |
| unavailable/unanswered from root | No authoritative answer: transport failure, bad scope/state/display path, or shared deadline | Publish failure |
| unavailable/unanswered from listing | No authoritative answer: transport failure, malformed page/entry, scope/directory/revision mismatch, incomplete listing, invalid/repeated cursor, page cap, nonlocal parent or abort | Publish failure |
| unavailable/unanswered from resolve | No authoritative answer: transport failure, malformed asset or abort | Publish unless already published by the canonical owner |
| unavailable/unanswered from run | No authoritative answer: deadline while queued or active, aborted start, or caught rejection | Publish failure |
| Ready or unplayable result | Resolved, joined or cached answer | No publication at this gate; fresh canonical answers publish in discover |
| Joined or cached unavailable result | Same discovery answer or failure as above | Publish only if not already stored |

Exhausted is produced by the recovery API outside `run`, not by discovery.
The queue cancellation symbol alone bypasses failure publication. Existing
not-listed, remote, root and listing failure coverage remains intact.

## Checks

Touched and neighbour command:

```
node_modules/.bin/vitest run src/lib/media-resolve.test.ts src/lib/media-resolve.harness.test.ts src/lib/local-image-save.test.ts src/lib/local-image-controller.test.ts src/lib/local-image-budget.test.ts src/lib/workspace-links.test.ts src/lib/image-reference.test.ts src/lib/composer-attachments.test.ts src/components/ImageMedia.test.ts src/components/MediaPlayer.test.ts src/components/MediaPlayerLifecycle.test.ts src/components/ChatMarkdown.test.ts src/components/ChatMarkdownScope.test.ts src/components/ChatMarkdown.render-once.test.ts
```

234 passed, 3 failed across 14 files (13 passed, 1 failed). The three failures
are the unchanged exact-object assertions at media-resolve.harness.test.ts
lines 190, 218 and 238: expected unavailable without the existing why/outside
field. These are the same failures whose baseline reproduction is recorded in
local-image-round2.md. Log: `/tmp/local-image-round3-tests.log`.

All existing assertions were retained. One regression test was added. Tests
use isolated recording fakes and temporary filesystem fixtures, never the live
app or user data. No full rig or browser workflow was run.

Additional checks:

```
node_modules/.bin/vitest run src/lib/media-resolve.test.ts
node_modules/.bin/tsc --noEmit -p tsconfig.json
node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit -p tsconfig.server.json
node scripts/ci-test-tiers.mjs check
node --experimental-strip-types scripts/build-local-catalog.mjs --check
node scripts/generate-locale.mjs --check
```

Tier check passed: 3480 files, 1996 gate, 1484 extended. Catalog check passed:
283 entries, 204 solo profiles, 2766 skill references, zero declared but not
shipped. Locale check passed: 8 languages, 4067 English strings.

The standalone resolver run passed all 46 tests, including the regression and
both existing discovery failure cases. Log: `/tmp/local-image-round3-green.log`.
Both TypeScript projects passed with exit 0. Logs:
`/tmp/local-image-round3-tsc-client.log` and
`/tmp/local-image-round3-tsc-server.log`.
