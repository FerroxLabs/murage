# Release check ahead

At RC cut, before the version-bump PR or any release build:

- Run node scripts/signal-inventory.mjs --assert-release-pin. A missing reviewed G0 fixture manifest, S1-SYNC proof or runtime hash blocks the cut.
- Run node scripts/signal-inventory.mjs --assert-runtime-inputs on the Signal integration branch while G0-live is pending; this omits only G0-live.
- Rebuild all three Signal archives on Linux and compare fragments with the committed pin. Check the 51-jar licence inventory and source offer.
- Confirm release.yml stages and verifies each target without conditional skips. On first publication it consumes its own verified workflow artifacts; public runtime assets are uploaded only by the publish step.
- Finish native packaged qualification on macOS arm64, Windows x64 and Linux x64. Linux archive assembly does not prove target execution.

The prepare-release.yml pin gate and the first release.yml job enforce the same release-pin command.

## Bundled Fuigo 1.0.43 (prepared before npm)

- BLOCKED until publication: `scripts/fill-fuigo-pin.sh <linux> <win> <darwin>` takes reviewed executable SHA-256 values for linux-x64, win32-x64 and darwin-arm64, in that order. It verifies npm archive integrity, package identities and all six executable headers/digests without executing them, fills the source/receipt/digest slots, and refreshes the lockfile with install scripts disabled and networking offline.
- Run `pnpm exec vitest run scripts/prepare-fuigo.test.mjs scripts/fill-fuigo-pin.test.mjs server/fuigo-native-update.test.ts` and `pnpm typecheck` in an isolated container after filling.
- Run the opt-in `server/drivers/acp/fuigo-bundled-real.test.ts` with the staged Linux x64 binary in an isolated, network-disabled fixture. Native macOS/Windows qualification remains owed; preparation is not execution evidence.
- No Fuigo entry exists in any package manifest or `pnpm-lock.yaml`: this engine is staged separately. Do not add an unused Node launcher dependency or invent registry integrity before publication. Historical release receipts and captured 1.0.42 protocol fixtures keep their original versions.
