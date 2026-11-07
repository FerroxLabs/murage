# L9 option B build

This item does not close the parent substitution race or the parent swap work.
The local credential-shape answer is advisory and exposes a coarse predicate.
A writer controlling the credentials entry or an ancestor can redirect reads
under the server's existing filesystem permissions. A planted file before the
initial observation, or a write inside the directory, already yields true.
A lasting replacement fails the identity comparison. A redirect before candidate
lstat, held through open and restored before the folder recheck, can yield true
from an outside file even after the original directory identity was observed.
Final-component no-follow flags depend on platform support.

B1/G2/G3/G5 correct the contract. The three directory checks are identity
observations, not a binding. Operational errors collapse in readKimiCandidate;
the deadline stop collapses in kimiSignedIn. The 64 KiB plus one buffer,
256-entry/32-open caps, deadline, shared promise and handle cleanup remain.
The renamed late-substitution test proves candidate inode mismatch only.
See [the per-hit audit](contract-audit.md).

B2/G1 characterize the accepted limitation: the inside file is a tombstone,
the outside file alone has distinct access/refresh sentinels and padding.
The handle spy proves the outside bytes were read; no swap returns false.
Malformed JSON is also covered. Real server probe and snapshot tests perform
the same early substitution and capture fixture logs. Tokens and byte totals
must not escape. These are characterization guards, not red-to-green fixes.

B3/B6 is the runtime fix. Kimi publishes signInAnswerIsLocalHint in its snapshot.
ProviderRegistry.engineLoginSnapshot reads the raw answer and its provenance
once. The sign-in probe still answers authenticated, but the local hint cannot
clear a rejection mark. A ready setup-check reply, a finished turn through
noteInstanceTurnOk, a registry settings change, or the existing TTL still can.
Other engines retain their sign-in-probe clearing behavior. EngineSetup offers
its existing SetUpCheck while the local hint remains marked. The dialog's eight
translations describe checking sign-in and direct the owner to try a reply;
they no longer promise a successful login from this observation.

B4/G6 characterize turn independence. The fake CLI's auth-required mode refuses
session/new for true, false and unknown scans (plus malformed input). Complete
protocol traces match and carry no sentinel. A fresh turn uses session/new;
session/load requires a resume cursor. B5 pauses with a candidate handle open,
stops the CLI, starts another refused turn and requests a snapshot. Stop does
not cancel the scan; same-root callers share the expired unknown answer until
cleanup. A fresh process imports an empty scan map and reads independently. The real
verification server also restarts while an expired read still owns a handle;
the restarted server answers true instead of reusing the expired unknown.

G4 consumer audit (paths at this build; functions are stable anchors):

- server/drivers/acp/core.ts:2541: requireAuthenticationBeforeSpawn is absent on Kimi.
- server/drivers/acp/core.ts:5207: authFailure is continue and pickAuthMethod is null.
- server/drivers/acp/core.ts:5927: snapshot status and CLI metadata only.
- server/harness/registry.ts:296: engineLogin reduces the raw snapshot to boolean/null.
- server/default-engine.ts:154-159: signInRank influences default preference, not eligibility.
- src/lib/engine-chat-link.ts:56: true selects the signed-in link.
- server/engine-health-routes.ts:99-100 and src/lib/today-model.ts:224-226:
  these are actually false-first status consumers, with an unknown check.
- server/setup.ts:129: false means sign-in is needed, not a turn gate.
- server/index.ts:30977 (sign-in probe) and server/key-rejections.ts:152-154:
  the changed probe cannot erase the mark using a local hint; withInstanceMark
  continues to show signed out. No other consumer policy changed.

R1: 1b4f75f181 introduced --print-logs at server/drivers/acp/opencode-go.ts:846 (spawnArgs) to surface
owned provider failures (OPENCODE-QUIET). The cloud-home test's exact old argv
source assertion became obsolete, not its credential-grant expectation.
The assertion now requires both acp and --print-logs; credentialEnv, key isolation,
HOME, PATH and updates-off assertions are unchanged. No production OpenCode code
or B7 (d4529b5c7a) is changed here.

R2: pool and engine-tree baseline comparison is recorded with final validation
in the build evidence. Their behavior is outside this lane; no changes are made.
