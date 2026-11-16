Collector/adapters producer owner: Builder B; journal/recovery producer owner: Builder A.
Protected enrollment, operation-side service/controller, deployment and evidence custody owner: MAIN.
Signing identity owner: secure administration; SAC/S4 acceptance owner: GrokBuild; HOLD release owner: Sean.

The collector is PARTIAL. `CaseRunner` implements explicit schedules for every
one of the unchanged 21 plan cases. All schedules run end to end with doubles in
the selfcheck assembly. The production CLI validates its request and the section-5
seam table, then refuses through the explicitly unenrolled production observation
authenticator. It does not yet bind the protected operation-side implementation
of ICaseOperations or IAssetsMeasurements; this is an implementation gap, not a
new reserved seam. No production witness PASS or workflow handoff is claimed.

The supported CLI shapes are:

```
witness-collector.exe --witness-case CASE_ID --request ABS_REQUEST_JSON --output ABS_CASE_DIRECTORY
witness-collector.exe --assets ABS_ASSETS --signing-output ABS_SIGNING_OUTPUT --source FULL_SHA --output ABS_OUTPUT
witness-collector.exe --validate-enrollment FILE --sha256 DIGEST
witness-collector.exe --reap-run RUN_NONCE
witness-collector.exe --supervise RUN_NONCE --collector-pid PID --collector-creation FILETIME --expires UTC
```

Witness mode refuses CI, validates protected immutable enrollment and holds the
collector, tag, candidate and evidence references during collection. The request
cannot select tools, endpoints, keys, adapter acceptance or authentication mode.
D2(1) fixes identity.version at 1.0.19. The shared release verifier, pack runner and positive fixtures use that same
reviewed literal; both relabel directions and matched 1.0.20 remain negative.

`enrollment.adapters` has exactly observationAuth, sacAdapter, s4Mechanism,
signingPath, cloudReaper and promotionTarget. Each is `unaccepted` or an object
with exactly accepted and sha256. Legacy enrollment without adapters grants no
acceptance. Seam errors name the seam/ruling; the observation error is the exact
D2(7) code WINDOWS_WITNESS_OBSERVATION_AUTH_UNENROLLED. Refusal precedes journal
creation and effects and writes neither result.json nor PASS. Every case needs
observationAuth. See the binding section-5 matrix for its additional seams.

The runner's order is admission, bound journal open, independent supervisor arm,
observation begin, then fresh operation binding per variant. It registers every
reserved resource before the action, checks exclusivity before faults, observes,
restores/revokes, and invokes Builder A's independent ConfirmAbsent. It hashes
capture bytes with CaptureWriter, rechecks all resource absence, finalizes the
observation and journal, and publishes result.json last. A failure leaves the
journal for independent recovery. No capture can exceed 128 MiB; the 20-minute
case budget includes cleanup. No truncation, omitted variant or budget increase
is permitted.

A successful result carries schema, caseId, runNonce, nonce, sourceRevision,
identity, status PASS, every independently measured observed field, one capture
per category, resources {created,destroyed,remaining:[]}, and cleanup.resources
with exact type/id/incarnation and absence measurement time. Capture rows carry
kind, file/name, sha256 and size. Values are compared with plan.expect only as a
validation step; the runner never derives a measurement from those expectations.
The durable result is staged outside the final name, flushed, then renamed
exclusively after evidence-manifest.json is durable. Existing files are errors.

ObservationChannel authenticates the named-pipe server before reading bytes:
SYSTEM token, exact sealed image path/hash, held process/image handles and creation
time. It enforces frame bounds, exact OperationBinding echo, contiguous sequence,
observer lifetime and finalization. The verbs are token-of, process-tree,
ci-events, service-state, wfp-filters, job-members, ci-build, ci-policy-state,
ci-policies and ci-log. There is no command execution verb.

`sac-interval-v1` consumes those authenticated CI responses and rendered EVTX XML.
It checks build/UBR, DWORD enforcement state 1, pinned CiTool hash/exact argv,
enrolled active policy/digest, log capacity/retention, contiguous records from a
pre-install bookmark through S4 teardown, boot identity, loss and observer health.
Unclassified events and unexplained policy changes fail closed. Two snapshots
cannot establish continuity. The collector contains no registry/CiTool/log reader.

`s4-own-token-dacl-v1` requires a fresh suspended standard-user process from the
installed signed path/hash, distinct primary token IDs, deny-adjust/query-allow
DACL before resume, and the candidate's own OpenProcessToken failure with native
access-denied marker followed by EPOWER and no engine/job. A different fresh
success process must have both shutdown LUIDs absent, including disabled entries,
and no adjust-access deny. A descendant cannot substitute for the process created
suspended. Before creation, the launcher arms an anonymous kill-on-close job.
STARTUPINFOEX's JOB_LIST assigns the child atomically inside CreateProcess, so
collector death before PID registration closes the only job handle and kills the
child. A later AssignProcessToJobObject is not used. Termination waits consume
only the remaining original case deadline. The disposable native probe never counts as the signed-byte witness.
Slice 6 remains refused until MAIN records the accepted demonstration.

Workflow collection exposes only IAssetsMeasurements reads. It refuses witness
enrollment and has no fault, service-stop, revocation or destruction interface.
It checks an extension-independent MZ set, dual native/signtool verdicts, per-file
leaf hashes, asset stability and the same SAC evaluator, and prepares candidate,
evidence, captures and manifest. `pe-leaves.json` binds each measured path and
file SHA-256 to its leaf DER SHA-256; the authenticated manifest covers it. It never writes a witness result or case PASS.
The production measurement binding and real installed-PE acquisition are pending.

`evidence-manifest-pin-v1` is canonical UTF-8 JSON containing the binding and the
sorted name/size/SHA-256 of every capture and result, or workflow output file.
MAIN transfers exact bytes through its existing channel, rehashes them and all
listed files, and pins the manifest digest in protected configuration outside Git.
The verifier rejects stale bindings, changed bytes, declared/unpinned digests and
noncanonical serialization. It creates no key. An optional public-key verifier
exists behind IEvidenceAuthenticator, but production never selects Option B or
accepts either controller key for observation authentication. Custody is still
Sean's decision; a nonce supplies no authentication.

Run Adapters.mutants.ps1 -Selfcheck for portable checks and without that switch
for behavioral mutations. Fixtures and doubles are excluded by the production
csproj. Adapters.native.ps1 requires independently pinned existing SYSTEM
observation service and a disposable probe on the admitted non-SAC workstation.
RUN-ON-WINDOWS.md gives the prerequisites. Beast, NativeAOT, deployed observer,
real signing/SAC/S4 and full release acceptance are still unchecked. HOLD stays.
