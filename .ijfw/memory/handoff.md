# Murage current release handoff — 0.1.51 PUBLISHED

COMPLETE: Both READMEs remotely verified (source10538965, downloadscbebe245); release goal finished. No pending publication or documentation work. Current machine-readable state `.planning/HANDOFF.json` and receipt `.planning/0151-publication-receipt.json` are authoritative. Broader deferred features and older incidents remain follow-ups, not part of this completed patch.

AUTHORITATIVE LATEST: 0.1.51 published2026-09-10T15:41:47Z, release386412188/latest/nonprerelease. All21 remote assetdigests/sizes and publicfeeds/5stablealiases verified. Sourceacaee1db, Macattempt2/Windows/LinuxallrequiredgatesPASS. No activeupload/buildhandles; do not republish. See `.planning/0151-publication-receipt.json`. README update verification is the only remaining release-documentation task. Earlier pending entries below are historical and superseded.

LATEST: all platform gates passed, all21 files verified. Draft386412188 exists (NOT published); parallel disjoint guarded uploads14066/8160/63838 active. Stage `/private/tmp/murage-0151-release-stage`; read final execution-record entry before resuming. Mac attempt2 now fully SUCCESS, superseding older pending states below. Next uploaded-digest verification→guardedpublish→publicfeeds/downloads→READMEs. Do not start another upload while these handles run.

Active task: urgent concurrency correction and publication. Read `.planning/0151-installed-contention-investigation.md` for authoritative contract, evidence and counters; ignore historical pending lines below. Accepted source `acaee1dbfb5551ae41d5f0d24c6bf3a314e5a282`, pushed work/0151-concurrency; checkout `/private/tmp/murage-0151-concurrency`.

Two Mac Auto/local bots, actual scoped proxy→HTTP→fake MCP and cancellation isolation passed. Existing29checks, broker/transport15, types, bundle and isolated packaged-server smoke passed. Approved diagnostic extension fixed malformed fixture JavaScript only; counts preserved.

Windows34490695635 SUCCESS: native Node23tests, build and signatures. Linux34490172233 SUCCESS: build and scoped smoke. Five primary files downloaded and hash-verified in `/private/tmp/murage-0151-release-stage`. No new native Windows installation qualification. Earlier failedWindows34490171537 used unsuitable Mac-specific fixture; never counted as pass.

Mac34490171017 attempt1 FAILED codesign timestamp on x64 libvips. One failed-job retry attempt2 is ACTIVE (producer102922150723); same accepted source/workflowf21dbb08. This is Mac package round2, NO further automatic retry. Require successful signing/notarization and both native jobs; cleanup state is not success. Stage worker engine_failure_0151 handles exact new artifact download; patch_release_prep monitors Mac.

No0.1.51 draft/upload/publication yet. User urgently requested release; five-minute deadline explicitly reported unachievable with required signing retry. Next: finish attempt2, validate exact21assets/feeds, guarded upload/digests/publish, public verification and reviewed README proposal `/private/tmp/murage-0151-readme-notes.md`. No live app/profile changes, no deferred features, no full-suite reruns. Old engine and Mac shutdown incidents remain disclosed, not claimed fixed.

## Historical 0.1.50 account-switch log — superseded, never resume these jobs
RELEASED NORMAL0.1.50 2026-09-10T13:36:58Z release386306693/latest/nonprerelease. 21digests/publicfeeds/downloads verified; sourceREADME426d0d3e/publicREADME40217ea8 verified. See .planning/0150-publication-receipt.json. Knownlimitations disclosed/userdispositionaccepted; notclaimedfixed. No activeVM/jobs. Historical pendinglines below superseded; do not republish.
LATEST13:18:37UTC: workload PASS/useful-read+handled-failure+cancel; guest CLOSED/allownedgone/backingspreserved. Old live-process notes below are historical. No job to resume. Await explicit release-limitations disposition, then guarded publication; nothing published.
Read `.planning/.continue-here.md` and `.planning/HANDOFF.json` first.
Timestamp: 2026-09-10 13:07UTC; notreleased/notcomplete.
Exact appsource15c3cbd64056a7288777739f5dd244ca4365ea0b, remote work/0150-integration.
Accessible root /private/tmp/murage-0150-build-recovery-fdatWt; Mando readsEPERM, do notchangepermissions.
Detailed Windows record windows-native/EXECUTION.md; inspect latestworker update beforeoperation.
LIVE guest hetzner-dsm lease recovery-uac-xckr66a2; VM605370/TPM605336/watchdog605984/WinRM58151.
HARD deadline13:48:29UTC. Verify exactstartidentity/cleanup beforeacting. No competingVM or silentextension.
P1 upgradepostconditions/uninstall/reinstall/freshprofile/reboot+postreboot passed; app7516/server1540/session1 left running. WorkloadNOTstarted.
Original upgrade exitcodeMISSING; notinferred0. P2 cutoff13:03:29UTC PASSED; reneweddispositionrequired.
Worker toldholdnewphases foraccountswitch; alreadyrunningoperation mayfinish, don'tduplicate.
Windows signedartifact/signatures/hashverified run34471681869.
Macbotharchsigned/notarized/nativequit+hashesPASS34473310308; Linux5lanes/hashPASS34473310353.
All21releaseassets staged /private/tmp/murage-0150-release-stage-vHGTTB; read PREFLIGHT.md; nothingpublished.
Claude actualbackgroundnotice bug fixed4f35f486, included15c; tests80pass1skip/types.
NativeWindows/Linuxupdaters fullmanagerverified/integrated; recoveredfixturetoken issue notcustomerengineincident.
Pendinguserdispositions: missingupgradeexit, older32603/1073807364 and originalMaccredentialdrain/custody limitation.
Userrequested releaseASAP, but failed/unverifiedgates notwaived. No tag/draft/upload/READMEpublicationyet.
Use Astra medium, up to3usefulworkers, rtk, explicitNode24.20/pnpm10.33; counters/failures surviveaccountswitch.
Remote recovery branch work/0150-continuation-record contains detailedhandoff; no buildtrigger.
