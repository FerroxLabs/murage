# English diagnostics and fixture prompts

All text in these two script trees is operator/test text. It is not shipped
renderer copy and does not enter the eight-language product translation catalog.
This inventory covers the lane additions since be6823cf1d and this repair.

| Files | English text and audience |
| --- | --- |
| run.mjs, counts.mjs | CLI usage/options; candidate, platform, catalogue, setup, cleanup, stream, transcript, incomplete action and card-count failures; machine result and Markdown verdict. Release operators. |
| scenarios.mjs, engine-inventory.mjs, platform.mjs | Stable scenario/driver names, model availability reasons, inert shell marker commands. Operators and isolated fake engines. |
| origin-fixtures.mjs | Pairing/identity, task/legacy/deadline errors; “Run exactly this shell command once” and denial-stop instructions. Fake ingress only. |
| r2-scenarios.mjs | Required fixture/room errors; exact Python, memory, peer, screenshot/browser, question, long-page and room marker prompts. Fake engine requests; unavailable tool/effect bindings say UNPROVEN. |
| bindings.mjs, workflow-fixture.mjs, app-fixture.mjs, legacy-fixture.mjs | Isolated queue/routine/project/email/app-denial prompts and missing receipt/policy errors. Inert fixture services. |
| field-plan.mjs, action-proof.mjs | Exact tool and full input request, outside-read ordering; action marker content is “fixture”. |
| decision-reader.mjs, observe-decisions.mjs, policy-accounting.mjs | Missing/replaced/truncated observer, missing durable store, hidden holds and mismatched presentation errors. Operators. |
| candidate-proof.mjs | “Candidate checkout or snapshot does not match the requested commit”. Covers missing Git, wrong SHA, dirty files, invalid snapshot paths, commit/tree/blob mismatch. Operators. |
| release-legs.mjs, mandatory-fixture.mjs, predicate-inventory.mjs | Absolute-suite, superseded-ruling, corpus absence, predicate inventory and isolation errors. Operators. |
| qualify-product-mutant.mjs, qualify-mutants.mjs, self-test.mjs | Mutation anchor errors, activated/killed/survived labels, fake qualification scope and releaseGate:false notices. Operators; never release proof. |
| fakes/*.mjs, fakes/reviewed-source.json | Fixed fake model labels, broker deadlines, local fixture completion and protocol diagnostics. No provider/user prose. |
| ../nolim-replay/production.mjs | Isolation and incomplete denial-context errors, unclassified card, “Approval verdict has no durable presentation”. Operators; bounded output only. |
| ../nolim-replay/ruling.mjs, run.mjs, replay-decide.mjs | Corpus SHA/row/source/label/input/context admission failures, UNPROVEN, ruling mismatches, wipe control requirements, replay worker/isolation/options/evidence errors and GNL-REPLAY counts. Operators. |
| *.node-test.mjs, mandatory-*.test.mjs, ../nolim-replay/*node-test.mjs | Assertion names and inert prompt/input examples describe the fixture behavior under test. Test runner only. |

No new user-facing product English or localization exemption is introduced.

G-NL r10 adds fixture/operator diagnostics only: `mounted-tools.mjs` reports
missing native permission decisions and closed mount transports; `bindings.mjs`
reports an absent saved-app native permission request. The generated catalogue
controls and structural/mutation qualifiers add test assertion text and inert
permission-peer descriptions. No renderer text or localization keys change.

The r10 review repair adds only fixture/operator diagnostics: missing native hooks,
missing explicit native allows, unavailable legacy mounted transports, unresolved
or unaudited dependencies, and mount transports outside the shared gate. The
new controls describe cross-thread/turn evidence and an API gate never consulted.
These strings are confined to generated fakes, the structural audit and tests.

The r11 import boundary adds operator/test diagnostics for forbidden imports,
nonliteral targets, unaudited file types, unresolved dependencies, symlinks and
invalid module syntax/data. The injected capability guard reports "A gated fixture
handle is required". Launcher bridges retain the existing protocol diagnostics.
No product copy or localization key changes.
