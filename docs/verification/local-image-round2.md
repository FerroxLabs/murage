# Local image discovery cache correction

Base: `13911a15441f72cd175a1afad2389a89d7224f67`.

Discovery failures now publish their current outcome to the canonical entry
before refresh or retry settles. Both cached aliases therefore see the failure
instead of the previous ready capability. Existing replacement ownership and
successful replacement behavior are unchanged.

## Red proof

With the new tests and the original production resolver:

```
node_modules/.bin/vitest run src/lib/media-resolve.test.ts -t 'discovery failure survives'
```

Exit 1: 2 failed tests, 43 skipped. There were 16 failed soft assertions:
refresh and retry, each with not-listed, remote, root transport failure and
listing transport failure, each checking the original and second cached alias.
Every received result was the stale ready capability instead of the expected
unavailable outcome. Log: `/tmp/local-image-round2-red.log`.

With the fix, the complete resolver file passes all 45 tests, including the
existing F4 settled and pending replacement tests and F9 generation retention.
Log: `/tmp/local-image-round2-green.log`.

## Checks

The touched and neighbour command was:

```
node_modules/.bin/vitest run src/lib/media-resolve.test.ts src/lib/media-resolve.harness.test.ts src/lib/local-image-save.test.ts src/lib/local-image-controller.test.ts src/lib/local-image-budget.test.ts src/lib/workspace-links.test.ts src/lib/image-reference.test.ts src/lib/composer-attachments.test.ts src/components/ImageMedia.test.ts src/components/MediaPlayer.test.ts src/components/MediaPlayerLifecycle.test.ts src/components/ChatMarkdown.test.ts src/components/ChatMarkdownScope.test.ts src/components/ChatMarkdown.render-once.test.ts
```

Result: 13 files passed, 1 failed; 233 tests passed, 3 failed, 236 total.
Log: `/tmp/local-image-round2-tests.log`.

The three existing failures in `media-resolve.harness.test.ts` at lines 190,
218 and 238 expect exactly `{ state: "unavailable" }`, while the resolver
already supplies a `why` field. Running that file with the original HEAD
resolver reproduces the same 3 failures and 4 passes. Production source was
restored afterward. Log: `/tmp/local-image-round2-harness-baseline.log`.
All existing assertions remain intact. Tests use recording fakes and isolated
temporary filesystem fixtures. No live app or user data was used, and no full
rig or browser workflow was run.

Additional commands:

```
node_modules/.bin/tsc --noEmit -p tsconfig.json
node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit -p tsconfig.server.json
node scripts/ci-test-tiers.mjs check
node --experimental-strip-types scripts/build-local-catalog.mjs --check
node scripts/generate-locale.mjs --check
```

The initial server type check exhausted Node's default 4 GB heap (exit 134);
the command above passed with an 8 GB heap. Both TypeScript projects passed.
All three inventory and locale checks passed.

Tier inventory: 3480 files, 1996 gate and 1484 extended.
Catalog: 283 entries, 204 solo profiles, 2766 skill references, zero declared
but not shipped, current generated catalog. Locales: 8 languages and 4067
English strings, valid. Installed binaries were used because pnpm is absent.

## Existing test changes

| File | Existing assertions changed or removed | Additions |
| --- | --- | --- |
| src/lib/media-resolve.test.ts | 0 | Retry import and 2 parameterized tests covering 8 scenarios and 16 alias remount checks |
| All other test files | 0 | None |
