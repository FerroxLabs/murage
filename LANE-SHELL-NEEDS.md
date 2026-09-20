# LANE-SHELL-NEEDS

Requests from the shell lane (App.tsx, Composer, SettingsModal, FirstRunRail,
src/lib/first-run.ts) for files this lane does not own.

The shell lane deleted the three stacked onboarding surfaces:

- `src/components/SetupPanel.tsx`
- `src/components/SetupChecklist.tsx` + `SetupChecklist.test.ts`
- `src/components/Onboarding.tsx`
- `src/components/FluxInvite.tsx` + `FluxInvite.test.ts`

Everything below is a consequence of that, in a file this lane must not edit.

---

## 1. BLOCKING: `src/components/RemoteSurface.test.ts` (owner: whoever owns the surface lane)

This suite fails to LOAD, because line 34 reads a deleted file:

```ts
const onboarding = read("./Onboarding.tsx");
```

Three things are needed, and the rule the suite protects must survive all of
them. The rule is: **no first-run screen on a surface that is not a confirmed
desktop, and `undefined` is not a desktop.** That rule is intact in the new
code and is easier to keep than before, because the client no longer forms its
own opinion about whether an install is new.

1. Drop the `onboarding` source read and the `Onboarding.tsx` entry from the
   `gated` list. Add `["FirstRunRail.tsx", read("./FirstRunRail.tsx")]` in its
   place. `App.tsx` stays in the list and still passes every shape rule in
   section 5 (no `desktop ? `, no `desktop === true ? `, no `desktop !== false`,
   still contains `useDesktopSurface`).

2. Section 1, "the welcome / email gate never reaches a phone". Replace

   ```ts
   expect(app).toContain("{desktop === true && gated && <Onboarding onDone={() => setGated(false)} />}");
   ```

   with the line that replaced it in `Shell()`:

   ```ts
   expect(app).toContain("{desktop === true && <FirstRunRail />}");
   ```

   `expect(app).toContain("const desktop = useDesktopSurface();")` still passes
   (it is now in both `Shell` and `App`).

   The `emailGateDone()` assertion has nothing left to assert: the gate does
   not key off localStorage any more, which was the bug. The honest
   replacement is the positive form of the same rule, against
   `src/lib/first-run.ts`:

   ```ts
   const firstRun = read("../lib/first-run.ts");
   expect(firstRun).toContain("view?.firstRun === true");   // the server decides
   expect(firstRun).not.toMatch(/localStorage|sessionStorage/); // and nothing else does
   ```

   `src/lib/first-run.test.ts` already proves the behaviour end to end
   (a `firstRun: false` view produces nothing, on every path in).

3. Section 1's "takes the ENGINE SCAN and the workspace check with it" and
   "is locked a second time in the component itself", and section 4's "keeps
   the engine installer inside the screen that is already gone", are all about
   `Onboarding.tsx` and can go. What replaced them: `<EngineSetup>` is no
   longer reachable from any first-run surface at all. It is reachable from
   `EnginesSettings.tsx` and `ModelPicker.tsx` only, both of which are behind
   Settings, and Settings already gates its desktop-only sections. A
   replacement assertion worth keeping:

   ```ts
   expect(read("./FirstRunRail.tsx")).not.toContain("<EngineSetup");
   expect(app).not.toContain("<EngineSetup");
   ```

## 2. BLOCKING: `src/lib/use-active-skin.test.ts`

Line 20 reads the deleted `components/Onboarding.tsx` at module load, so the
suite throws on import. The read is only used by the file header's story; the
actual rule ("wherever the white raster is shown, the light theme gets the
dark one") is enforced by the `sources()` walk over all of src, which needs no
per-file read. Deleting the `const onboarding = ...` line and the one comment
that names the screen is enough. Nothing in this lane shows
`/murage-logo.png`.

## 3. BLOCKING: `src/lib/flux-invite.test.ts`

Line 265 reads the deleted `components/FluxInvite.tsx` inside
`it("offers the key without blocking anything: no overlay, no dialog")`, so
that one test throws. The rest of the suite passes: the `OWNERS` set is
intersected with the files that actually exist, and the positive control
(`readers` contains `lib/use-flux-invite.ts`) still holds.

The rule that test protects is worth keeping, and the surface it now applies
to is `src/components/FirstRunRail.tsx`:

```ts
const rail = readFileSync(join(srcRoot, "components/FirstRunRail.tsx"), "utf8");
expect(rail).not.toMatch(/inset-0/);
expect(rail).not.toMatch(/role="dialog"|aria-modal/);
```

`src/components/FirstRunRail.test.ts` asserts exactly this already, so
deleting the test here loses nothing. Please also drop
`"components/FluxInvite.tsx"` from `OWNERS` so the list does not rot.

## 4. Dead code left behind, nothing blocking

These are now imported by nothing. This lane did not delete them because it
does not own them, and because at least one of them may be wanted by another
lane. Please confirm and remove, or say what still needs them:

- `src/lib/onboarding-progress.ts` and `src/lib/onboarding-progress.test.ts`
  (`ONBOARDING_CHOICES`, `readOnboardingProgress`, `seedBotCandidate`,
  `isUntouchedSeedThread`). Only `Onboarding.tsx` ever used them. The
  "is this workspace established" question they existed to answer is now
  `view.firstRun`, answered by the server from live state.
- `src/lib/flux-invite.ts` and `src/lib/use-flux-invite.ts`
  (`FLUX_INVITE_DISMISSED_KEY`, `fluxInviteVisible`, `useFluxInvite`). Only
  `FluxInvite.tsx` used them.
- `emailGateDone()` in `src/lib/analytics.ts` now has no reader.
  `setEmailGateDone()` is still called by `FirstRunHelloCard.tsx`, so the
  storage key itself stays in use. Leave the writer, the reader can go.
- `src/components/FluxKeyCard.tsx` is still used, by `EngineSetup.tsx`. Not
  dead. Noted only because its test was updated by this lane.

## 5. Comment references to deleted files

- `src/components/ConnectedAppsLock.tsx:87` says
  "It lived in SetupChecklist.tsx, which is a first-run panel and can go away".
  It has now gone away. One word of the comment is stale.
- `src/components/FirstRunHelloCard.tsx:4,53` cite `Onboarding.tsx` as the
  source of the signup it reimplements. Accurate history, but the file is no
  longer there to read. Worth rewording to name the commit instead.

## 6. e2e specs that mount `Onboarding.tsx` directly (not vitest, not run here)

Not blocking any vitest run, but they will fail the moment the human suite is
run. Owners of `src/e2e/` please retarget or retire:

- `src/e2e/onboarding-engine-step.human.spec.ts` (mounts `<Onboarding>`)
- `src/e2e/onboarding-save.human.spec.ts` (mounts `<Onboarding>`)
- `src/e2e/starter-profiles.human.spec.ts` (mounts `<Onboarding>` as a fixture)
- `src/e2e/flux-entrypoints.human.spec.ts` (`openFromOnboarding` drives it)
- `src/e2e/remote-surface.human.spec.ts` (comment cites `Onboarding`'s
  `checkWorkspace`)
- Many specs seed `localStorage["murage-setup-seen"]` and
  `localStorage["murage-flux-invite-dismissed"]`. Both keys are now read by
  nothing. Harmless, but they no longer do what the line says they do, and a
  spec that relies on them to suppress a first-run surface will need the
  server's `firstRun` to be false instead.

## 7. Pre-existing failure, not caused by this lane

`src/lib/tokens.test.ts` "token drift keeps raw hex out of everything but the
allowlist" fails on **`src/components/FirstRunPhoneCard.tsx`** (2 raw hex
values, `#ffffff`). That file belongs to the cards lane. Either use a token,
or add it to `ALLOWED` with the reason `PhoneSetupFlow.tsx` already carries
(a QR code needs literal black and white to scan).

## 8. Copy that wants to move into `src/lib/first-run-copy.ts` (cards lane owns it)

The rail needs six row labels and five state words. Four of the six labels are
imported from `FIRST_RUN_COPY` already, so a row and its card cannot drift
apart. The rest are declared in `src/lib/first-run.ts` as `FIRST_RUN_RAIL`,
because this lane does not own the copy module:

- `hello` label: "Say hello"
- `agents` label: "See what is already here"
- title "Getting set up", close "Close this list", progress "2 of 6 done"
- states: "Now", "Passed over", "Waiting on something" (and `FIRST_RUN_COPY.settled` for done)
- footer: "Close this whenever you like. Nothing in it stops you using Murage,
  and all of it stays in your chat."

If the copy module should be the single place the product owner reads, please
move `FIRST_RUN_RAIL` into `first-run-copy.ts` and re-export it. Its copy rules
are already enforced by `src/lib/first-run.test.ts`.
