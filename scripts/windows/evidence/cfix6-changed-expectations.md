# cfix6-winscen expectation ledger

Binding source: `/work/fuigo-builds/swarm-b/winhide-ruling/RULING-winscen-p11e-MAIN.md`, over p11d for JS/MJS/CJS only. Review witness: `/work/fuigo-builds/swarm-b/crev5-winscen/last.txt`, P1. Baseline HEAD and hub branch both verified as b931f63ffcd81450e21b988e8d4f23050082e634.

- The reviewer's exact imported-alias/parenthesized-call input must fail. RED was recorded before changing the scanner.
- JavaScript now rejects restricted module imports/re-exports/requires at their source and checks each process reference against the MAIN member allowlist. Dynamic import, eval/Function/vm, process aliases/destructuring/value passing, computed access and indirect global access fail. Existing native member checks remain supplemental protections, not the authorization rule.
- Registration with process.on must be a direct statement with exit/SIGINT/SIGTERM: its return value is process and cannot escape as an alias. Methods must be called directly; stdout/stderr permit only direct write calls. No kill/spawn capability was added to the allowlist.
- Existing non-owner process.execPath use (echo test, fixture-feed tests, ownership/safety/p11c/p11d/receipt mutation harnesses) moves into fixed runNodeFixture/startNodeFixture helpers in native-launcher.mjs. They retain the Linux-only guards.
- echo-mcp.mjs legitimately needs its own pid, readline stdin and the installed-preload symbol. These operations move into fixed owner helpers returning only pid, readline interface and a boolean. No general process accessor is exported.
- native-launcher.node-test.mjs legitimately mutates and restores the process platform descriptor to verify Windows refusal. This test operation moves into the existing owner and now checks the Node fixture wrappers too.
- fixture-feed.mjs generates a bootstrap needing pid and a dynamic fake-engine import after recording mount evidence. The entire existing generator moves into the owner and is re-exported; execution order and generated contents stay unchanged.
- Ordinary test imports become static. The receipt mutant now writes an isolated copy with a fixed mutant import instead of environment-selected dynamic loading. Missing-half rejection assertions are retained.
- Exactly the same two absolute owner paths remain exempt. No test/check/mutate directory or basename exemption is added. PowerShell, batch, Desktop protections, cleanup ordering and deadlines are unchanged.
