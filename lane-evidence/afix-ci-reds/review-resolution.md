Fix-round base: 5138c3ede2b42d9741d704004b3834f751362586.

High C2 remains OPEN. Retrieved full quality-gates Windows job 131259233667
from public run 43240481769 through the connected GitHub API. The retained
windows-failure-details.log identifies all native assertion sites: CLM reader
returns null at storage.test.ts:392 (run version); nine subsequent failures are
storage-permissions / data-dir at initial accepted-state checks (404, 423,
439, 474). This narrows the issue to reader/setup rather than rename/lock.
It does NOT prove which underlying native command failed: storage reader catches
and maps exceptions to null. The prior explicit-ACE explanation remains a
hypothesis, not an established root cause. No additional product change is
justified by these logs. Passing Windows qualification cannot be supplied from
this Linux-only lane; do not clear C2 or release.yml.

Medium baseline proof: baseline.mjs removes the Windows custody adapters from
the real host fixture, runs the new startup regression, requires exit 1, restores
the file in finally, and runs the complete touched host/storage suites. The same
source-deletion mutant is killed by that regression. Receipts are untracked.

Low English inventory: english-inventory.json inventories the test-only ACL
setup diagnostic. No user-facing English was added.

EARLY-REVIEW.txt absent at start. C1/C3 were accepted and were not reworked.
Project memory prelude tool unavailable; .ijfw/memory absent. No live app/data
was contacted. This round asserts unit fixture behavior only, not a server
workflow or native Windows behavior.
