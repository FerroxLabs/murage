# HighLevel C1 grants and Settings

This slice is integrated with `67367218d`. It preserves that base's single
journaled write dispatcher, both legacy call journals, and conservative crash
recovery. The shared `finalDecision` implementation is copied unchanged from
`662be559e`; HighLevel uses it for the final approval decision. Destructive
operation attendance remains a HighLevel eligibility condition.

`ownerGrant` accepts complete family levels. `ownerReadGrant` remains only as a
compatibility parser for old tool-list requests. The effective reader validates
role, bot and revisions before mapping legacy reads. The host now consumes that
same reader instead of the integration base's temporary structural grant parser.

Run only in an isolated, network-disabled test container through the lane runner:

```sh
IT_JOB=afix-hlc1-r3 \
IT_W=/work/build/hlc1/wt \
IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh \
/work/fuigo-builds/tools/it-remote.sh \
'mkdir -p .test-tmp/afix-hlc1-r3/api-final; HLC1_EVIDENCE_DIR=.test-tmp/afix-hlc1-r3/api-final npx vitest run server/highlevel/grants-management-api.test.ts server/highlevel/grants-management.test.ts'
```

The API test launches `launchVerificationServer`, runs Doctor, and uses a fake
engine and fake provider. Its desktop grant PUT, review GET, exact approval POST,
and internal tool calls use the actual server routes. It checks Can change and
Full control, one write on duplicate RPC, redacted phone status, read/revoke from
the phone, and rejection of phone escalation. The runtime tests additionally
check downgrade before dispatch and refusal of destructive calls at Can change.
No production account, private token, or provider network is used.

Evidence consists of `api.jsonl`, the fixture descriptor and Doctor output inside
that transcript, and `server.log`. The launcher deletes its private home and data.
The ephemeral turn credential remains only in that private fixture and is never
included in evidence. Settings helper/source tests and both TypeScript projects
are checked separately. These checks do not prove an Electron interaction smoke.

The incomplete C2/F1/F2 test grants were updated to the frozen complete family
shape. Fixtures that intentionally exercise all operations explicitly clear their
legacy operation allowlist. Production schema validation was not relaxed. The
old C1 restart assertion now checks the integrated `outcome_unknown` recovery
state for an approved write, with review values unavailable and no resend.

## Remaining integration requirements

The production private-token source now publishes its actual scope evidence on
the held check, owner view and runtime connection. It proves only
`locations.readonly`. Scope claims in a location response are ignored; changed
credentials clear the evidence. No write inventory is inferred from the token.
C1 keeps production write controls disabled and dispatch refused until a trusted
connection source supplies those scopes. Fixture scopes are explicit test data.
Do not treat owner-entered scope claims as verified provider metadata.

The remaining production decision is the source of authenticated scope metadata:
use the Marketplace OAuth broker (which needs Sean's app registration), or supply
a documented provider-authenticated PIT inventory contract. The current PIT
location GET cannot prove write permissions. The provider describes permission
selection and editing in its [private integration documentation](https://marketplace.gohighlevel.com/docs/Authorization/PrivateIntegrationsToken/),
but that connection flow supplies no scope-inventory response.

The API's explicit per-family `broaden` flag remains a provisional C1 interface.
All S0 authority declarations use the frozen contract. Explicit readonly fields
keep the Node strip-only runtime compatible with the frozen constructor API.
The snapshot parser folds only an explicitly marked equivalent migration; tests
still reject changes to readonly status, property type or constructor type. No
frozen snapshot or schema bytes changed. The absent native file helper stays
unavailable and refuses uploads; C3 remains responsible for its implementation.

Sol reviewed the prior Astra-authored bundle: 432 strings across all eight
languages and the changed same-as-English pins. The immutable review record is
`2026-11-11-highlevel-c1-r3-9c7ca88d2b2a`; the copy gate passes.
The missing file-helper diagnostic changed in r3 and is listed in the lane
handoff for Sol copy review. There are no new locale keys. Frozen schema
diagnostics retain their exact bytes; the copy scanner excludes only those
three internal literals, and runtime tests prove that invalid arguments return
the fixed public refusal instead of those diagnostics.

## Renderer interaction verification

`src/components/HighLevelSettings-renderer.test.ts` mounts the actual component
and its controls in an isolated DOM. It covers Simple downgrade preserving Off
families and existing reads, Advanced downgrade retaining operation restrictions,
explicit Full control, revocation, missing scopes and redacted phone status.
Simple changes never emit Full control. Downgrades never request broadening.

`scripts/smoke-highlevel-settings.mjs` bundles the production component and opens
it in an isolated Electron window with a fixture store and network requests
blocked. Supply an existing offline Electron executable and an evidence folder:

```sh
node scripts/smoke-highlevel-settings.mjs \
  --electron /absolute/offline/electron --out /absolute/evidence \
  --library-path /absolute/offline/runtime-libraries
```

Run this inside the lane's network-disabled container with its own display
(for example, Xvfb with TCP disabled). A minimal Linux container
may also need existing GTK runtime schemas via `GSETTINGS_SCHEMA_DIR` and font
configuration via `FONTCONFIG_FILE`. The script sets an isolated home, data and
Electron profile, keeps GTK settings in memory, records assertions/version and a
screenshot, and deletes its fixture. It does not download prerequisites or call
a provider. This proves interaction with the real component under Electron;
packaged main/preload and native macOS/Windows remain separate release gates.

Family implementations outside the contacts/opportunities integration base
remain their respective slices' responsibility.

The resumed r3 gate completed all 3,860 files at `b0d2758f5`, checking all 15,889
tracked inputs before and after each shard. Its eight failures absent from the
reference baseline exposed four C1 integration checks and four unrelated timing
failures. The latter pass as four unchanged files, with their original assertions
and timeouts (65 tests). The C1 changes and adjacent workflows pass in twelve
complete files (210 tests), including the isolated grant/review HTTP fixture.
The resulting file-by-file composite has no missing results and NEW=0; its 156
remaining failure lines, including the Lee scenario timeout, match the baseline.
This is the original full run plus complete-file retests, not one full invocation
at the later commit. Both original and derived reports remain in the lane evidence.

The closed transcript-writer inventory now includes HighLevel's own review card;
three behavior cases prove settlement changes only that card's metadata and
preserves conversation text. The outside-content classification names the mounted
family tools. Patched messages reach the conversation cache before review cleanup
notifies subscribers. The phone approval check requires both the computer-only
guard and refusal of HighLevel values. Four further mutants exercise these checks
and fail assertions; the earlier seven mutants also remain killed.
