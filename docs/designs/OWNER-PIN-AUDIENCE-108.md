# Owner pin audience (1.0.8 graduate-experimental, r4 design)

Two review blocks on retiring owner pins: simplify instead of a third patch.

## Today (dfbb4a4ba)
- A pin's files land on the task desk: `<desk>/.murage-procedures/<bundleId>/{skills,catalogue}/...` (procedure-bundles.ts:147-165). The desk is the engine's cwd for every turn of the task, owner or not.
- An owner turn's pin copies the owner's recordings into `catalogue/<id>` (procedure-bundles.ts:97-104), so they sit on the desk.
- Before a non-owner turn, `clearOwnerProjections` lists every folder in `.murage-procedures` and retires each owner bundle with file deletes plus `rmdirSync` (procedure-bundles.ts:264-311; index.ts:11031, :16556). Releases call `retireOwnerPinBestEffort` (procedure-bundles.ts:355, :360, :366; index.ts:11033, :12718, :16558).
- Holes found: a renamed folder (`<id>.bak`) is skipped by the name filter (:303); the listing grows with every pin (:302); `rmdirSync` checks only the last path part, so a symlinked ancestor reaches outside (:277).

## Options checked
1. Separate projection roots, both on the desk: a non-owner engine still has the whole desk as cwd, so it can list the owner root. Does not hold.
2. Owner material never on the desk: the owner's recordings project into app state, next to the pin's own bundle file. Holds, and the sweep is no longer needed.

## Chosen: 2
- `createProcedurePin` files an owner-only skill (not shipped, not `audience:"everyone"`) under `owner/<id>`, never `catalogue/<id>`. Only an owner turn's pin has any. Every new bundle records `ownerTurn: true|false`.
- `preparePinnedProcedures` writes `owner/` files only to `skill-state/<bot>/task-bundles/<thread>/owner/<bundleId>/`. That folder already holds the same bytes inside `<bundleId>.json`, so nothing new becomes reachable. Desk files stay limited to `skills/` and `catalogue/`.
- `procedurePinServesTurn`: a pin serves only the kind of turn it was built for. A bundle without `ownerTurn` (written before this change) serves no turn, so its owner copy is never written again: the task pins again.
- Owner turn: the recording's text is in the prompt as before. Its `root=` names the app-state copy, and for Auto/Full access that folder is passed as a read folder (`grantedDirs`). In Ask mode, and on room turns (which pass no read folders), the engine asks before reading it.
- Removed: `clearOwnerProjections`, `retireBundle`, `retireOwnerPinFiles`, `retireOwnerPinBestEffort`, the `nonOwnerBundles` cache, and every `rmdirSync`. No folder is ever deleted. The only cleanup left is the existing digest-checked file revoke when an audience is revoked, and it is hygiene, not the privacy guard.

## Per-turn cost
Flat. A turn reads only its own pin's bundle. Nothing lists `.murage-procedures` or the owner folder, however many pins the task has had.

## Not claimed
- No OS-level confinement. An engine on Full access or No limits that reads paths outside its folder on its own can reach app state, the same as it already could reach the source recording in `skills/` and every bundle file.
- Desk copies written by releases before this one (Teach a skill was Experimental, off by default) are not swept. Those pins are no longer reused.
- Imported skills (`skills/`) keep their own audience rule (skillAvailableForAudience); this design does not change it.
