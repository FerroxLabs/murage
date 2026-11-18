Witness pack/collector implementation and validation producer owner: win-sac-sign; protected enrollment/deployment/execution consumer owner: MAIN.
Signing identity owner: secure administration; S4 policy owner: GrokBuild.

Current implementation status: the native validation/build/enrollment core is in
`infra/windows-signing/collector/`, with a capture writer, durable journal/recovery and process-only reaper. Admitted
measurement adapters and the independent supervisor/full reaper remain incomplete.
Both collection entries refuse execution.
win-sac-sign retains implementation ownership; MAIN supplies approved protected
contracts, deploys and executes. Follow RUN-ON-WINDOWS.md and
QUESTIONS-FOR-MAIN.md before any real run. No native deployment is qualified here.
Enrollment and the actual signing/promotion gates require exactly `1.0.19`.

This pack drives the remaining real Windows signing/SAC witnesses. Release is HOLD,
including after a pack PASS. It never enrolls an identity, edits a certificate,
creates an account or connects to a Windows host. MAIN transfers it to the existing
tagged Windows 11 box and runs it there. No Mac build is involved.

`plan.json` is the complete 21-case checklist and expected observation/capture
contract. `Run.ps1` starts a separately pinned Node without inherited preloads or
secrets. `run.mjs` checks the independently selected enrollment digest, plan,
existing box tag and collector pins; invokes one sealed MAIN collector directly
per case; checks every required typed observation, capture hash and cleanup ledger;
and runs cleanup even after failure. A fresh output directory prevents reuse.
`verify` recomputes all 21 results, including cleanup; it does not accept summary.json
as proof. Interrupted runs can invoke `cleanup` independently. No SKIP is accepted.

Before running, MAIN must supply its existing deployment and enrollment:

- The protected SYSTEM boundary service/runner admission, reviewed sealed tools,
  independent checker+attestation, two distinct existing controller keys, OIDC/cloud
  adapters, extractor and collectors described in docs/releasing.md. The repository
  authority is intentionally unenrolled. Do not copy the example to the authority.
- A sealed native collector implementing COLLECTOR.md, accessible to the existing
  standard account. This is MAIN's interface to privileged service/cloud observation;
  the pack does not impersonate SYSTEM or acquire signing credentials. The current
  workflow SAC collector's ordinary `--assets` interface alone is insufficient:
  it also needs the witness-case interface. No sample collector or fake PASS is supplied.
- Exact candidate bytes and authenticated build receipts; an isolated app home and
  an already-configured real engine for this witness only. Never use the user's live
  Murage app/data. MAIN's collector owns process tokens, SAC state/interval exports,
  real turn/addon/S4 instrumentation and authenticating the resulting production proof.
- MAIN selects the existing tag file, runtime/collector/plan hashes and enrollment
  digest from protected configuration, independently of downloaded candidate data.
  All paths are absolute and sealed against reparse substitution. Stage the pack and
  its manifest in a MAIN-controlled directory, outside candidate artifact roots.

The canonical execution sequence for both Windows host roles, NativeAOT preparation,
public-reference freeze, all expected outputs, full run and recovery is
[RUN-ON-WINDOWS.md](../../RUN-ON-WINDOWS.md). The transferred private handoff includes
that runbook. Its current PARTIAL/HOLD stop conditions apply to this pack.
`Launcher.selfcheck.ps1` verifies CI refusal before the launcher clears the child's
environment; it is a portable guard check, not a real Windows qualification.

Run `node --test verify.node-test.mjs` to check the portable capture validator.
These synthetic validator tests are never Windows trust/SAC evidence. Raw captures
and the pack summary are diagnostics, not controller authentication. MAIN must bind
real captures, original build and publication identities and exact bytes into its
existing authenticated candidate/evidence/output envelopes, then run the unchanged
qualification and promotion validators at stage and publication. A mutable local
manifest, a hash, or a workflow success flag does not authorize a release.

Keep output and enrollment private outside Git. CodeIntegrity/process captures can
contain machine/account details; MAIN retains those in its evidence store and uses
neutral public summaries. Never commit captures, real enrollment or secrets.
