# Historical r1.1 attempt — superseded by bld2 r1.2

This is retained historical evidence, not a current stop condition. See IMPLEMENTATION.md and final.log.

S1 stopped before first commit: parallel review DISAGREE touches wire/parse,
approval-site structural inventory, and R3 input-tampering witness.

Base: 5cf79747a20edc2103bf80b90ff5c265f461e7bc
Branch: dev/1019-toolid-s1
Draft modules and tests are uncommitted and unverified. No driver migration.
TOOLNAME-READS inventory and structural test have not been implemented.

RED command (before implementation):
IT_JOB=bld-toolid-s1 IT_W=/fixture-home/fuigo-builds/swarm-b/toolid-s1/wt IT_ORIG=/fixture-home/fuigo-builds/tools/it-local-generic.sh /fixture-home/fuigo-builds/tools/it-remote.sh 'node node_modules/vitest/vitest.mjs run shared/canonical-json.test.ts shared/tool-identity.test.ts > lane-evidence/toolid-s1/red.log 2>&1'

Runner: murage-vt5, network-none disposable node:24-bookworm container.
Result: exit 1; both suites failed collection because implementation modules
were absent. Zero assertions ran. RED log retained; no GREEN run was made.
No server or conversation workflow verification was performed or claimed.
