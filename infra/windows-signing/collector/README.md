Recovery/journal API producer owner: Builder A win-sac-sign-sa; case-runner/observer caller owner: Builder B win-sac-sign-sb.
Protected store, task registration, enrollment, native execution and controller deployment owner: MAIN.
Security acceptance owner: GrokBuild; reserved custody/resource decisions owner: Sean.

The redesign keeps RELEASE_HOLD. Portable checks do not qualify Windows native
behavior, the SYSTEM observer, signing, SAC, or the cloud recipe. MAIN deploys and
runs the native checks; the collector holds no signing key or cloud credential.

Frozen API for Builder B:
```
ResourceJournal.Open(string path, string runNonce)
Register(RunResource resource, OperationBinding binding)
ConfirmDestroyed(RunResource resource, OperationBinding binding)
Finalize(OperationBinding binding)
record OperationBinding(string RunNonce, string CaseNonce, string CaseId,
                        string RequestSha256, string OperationId)
ResourceRecovery.ConfirmAbsent(IEnumerable<RunResource>, ReaperRegistry) -> bool
RecoveryEntry.Reap(string runNonce)
RecoveryEntry.Supervise(string[] args)
```
Nonces and digest are 64 lowercase hex characters, with distinct run and case
nonces; operation IDs are fresh 32-hex values. Finalize closes all operations in
the case. FinalizeRun closes the cleanup case and run. No reaped receipt can meet
a case's own destruction requirement. Register and flush before effects.

Open holds FileShare.None for the journal lifetime. Replay and append use one
transition function; append validates before writing and commits the prepared
transition only after Flush(true). Dictionary state and append work are constant
per row. The 8 MiB file and 16 KiB row limits stay. An external length change
poisons the writer. Torn tails permit recovery of the prefix, never completion.
Old unbound rows are rejected; MAIN starts a new run rather than migrating an
active journal. The hash chain detects corruption, not a malicious administrator.

RunResource.Incarnation encodings (private references, never credentials):

| Type | Incarnation |
| --- | --- |
| process | Decimal creation FILETIME; Id is decimal PID. |
| job | JSON runNonce, members:[{pid,creation}], membersSha256; digest is SHA-256 of UTF-8 pid:creation lines in member order, without final newline. Id is Global\MurageWitness-RUN-DECIMAL. |
| lease / capability | JSON runNonce, servicePid, serviceCreation, ownerPid, ownerCreation, childPid, childCreation, instance (32 hex); Id is the 64-hex lease nonce. |
| file | JSON runNonce, fileId; fileId is 16-hex volume serial + ':' + 32-hex FILE_ID_128 bytes. |
| task | JSON runNonce, nonce (32 hex); Description equals nonce, Id is \MurageWitness\RUN\NAME. |
| service-state | JSON runNonce, startType, state, binaryPath, sha256, exclusiveRunNonce; baseline includes the exact command line and binary hash. |
| wfp-filter | JSON runNonce, provider, sublayer; Id and both keys are nonempty GUIDs in D format. |
| install | JSON runNonce, uninstaller, sha256, fileId, rootFileId, userSid, session, registryKey. Id is the admitted isolated install root. |
| vm / os-disk / data-disk / nic | Controller-side node reaper inventory: full ARM id, runNonce, uniqueId, createdAt, owner, purpose, expiresAt. |

MAIN installs protected controller/runs/RUN/recovery.json with exactly runNonce,
scratchRoot and installRoot beside resources.jsonl. Both roots are absolute,
canonical, disjoint Windows paths. The journal/config ancestry admits write only
from SYSTEM and Administrators. Requests cannot select these roots. No reaper
falls back to another type. Every created resource is independently remeasured,
including resources already carrying destroyed receipts. Foreign incarnations
are retained and listed by the corresponding reaper. The supervisor task is
reaped last. File deletion uses the held FileId, rejects links/reparse objects,
and never recursively deletes an unregistered directory tree. Install recovery
runs the pinned uninstaller in the admitted standard-user session, then deletes
only the matching uninstaller and empty root, and rechecks the uninstall key.

Lease recovery uses the existing session disconnect-revoke mechanism. A gone
service incarnation is measurable without an observer. A live service requires
authenticated lease-unknown observation; the closed observer verb contract still
has no such verb, so production refuses R-COL(6) before any effect. MAIN must
resolve QUESTIONS-FOR-MAIN.md; the portable state machine covers both outcomes.
The cloud production ARM client likewise refuses R-COL(11). Portable ARM doubles
check exact incarnation, tags, ETag-conditional DELETE, independent GET absence,
and cleanup after controller death. No resource was provisioned.

MAIN pre-registers the SYSTEM supervisor before effects. It waits on the exact
collector process handle/creation FILETIME and expiry, without process polling.
Collector crash without run-finalized or expiry dispatches the same recovery.
The supervisor writes no result.json. Builder B owns CLI dispatch to these entry
points and both collection modes; this document makes no case PASS claim.

Run Collector.selfcheck.ps1 for codec, W-J1..W-J5 and per-type portable checks;
Collector.mutants.ps1 retains the earlier witnesses and adds M-A1..M-A13.
Native.selfcheck.ps1 covers held files, process, job and supervisor on an isolated
Windows host; -Native mutation mode remains required there. Test doubles and the
native fixture helpers compile only in the self-check assembly. Native outputs
and all mutation evidence stay outside the checkout. Real 21-case PASS and HOLD
release remain MAIN/GrokBuild/Sean operations after the reserved admissions.

Fix-round handoff (1019-WINSAC-REDESIGN): the shared release literal and witness
pack admit exactly 1.0.19 under D2(1); neither derives it from package metadata.
G-B uses distinct stage/publish request nonces bound to command, signed build
identity, publication attempt, installer hash and protected evidence/bundle pins.
Consumers authenticate the extraction-result envelope, materialize the archive
and rehash the actual installer and PE bytes through the shared verifier. They do
not launch the client. Stage carries the protected pins in its attempt artifact;
the writer checks them against its retained review SHA and release version.
Publish waits for its separate job in the exact attempt. No OIDC is acquired by
assemble or download. The journal's protected append endpoint still needs MAIN's
contract; direct file writes by the standard account are not an approved bridge.

English handoff inventory (developer/CI diagnostics only; no application UI):
- Audit diagnostics: "OIDC jobs cannot be reusable or hold job env";
  "OIDC environment outside reviewed qualification"; "OIDC job cannot access secrets";
  "OIDC job cannot run release-guard"; "OIDC job cannot hold GH_TOKEN or secrets";
  "OIDC job must have exactly its reviewed permissions";
  "required unconditional SAC stage gate missing".
- Workflow labels: "Fresh SAC extraction for stage", "Fresh SAC extraction for publish",
  "Extract and independently verify this invocation's exact installer bytes",
  "Download this stage invocation's signed extraction",
  "Gate prepared release on enforcing SAC and standard-user proof".
- Gate errors: WINDOWS_SAC_EXTRACTION_INVOCATION, WINDOWS_SAC_EXTRACTION_REPLAY,
  WINDOWS_SAC_EXTRACTION_REQUEST, WINDOWS_SAC_EXTRACTION_DIGEST,
  WINDOWS_SAC_EXTRACTION_REQUIRED, WINDOWS_SAC_GATE_USAGE and
  WINDOWS_SAC_STAGE_GATE_FAILED. These classify failure, never authorize a PASS.
- Recovery stderr JSON: event recovery-failed, resource type/id/incarnation,
  phase confirm-absent/reap, and error STILL_PRESENT, the exception type, or a
  WINDOWS_WITNESS ruling code. Exception messages and stacks are not exported.
