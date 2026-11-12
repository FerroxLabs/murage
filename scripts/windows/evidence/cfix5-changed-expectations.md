# cfix5-winscen expectation ledger

Binding source: `/work/fuigo-builds/swarm-b/winhide-ruling/RULING-winscen-p11d-MAIN.md`, over p11c item 3 only. Review witness: `/work/fuigo-builds/swarm-b/crev4-winscen/last.txt`, P1.

- Tighten scanner acceptance: the exact crev4 parenthesized multiline CIM input must fail. Existing fixture cases and all p11c assertions remain required.
- Tighten scanner implementation: PowerShell language AST and TypeScript JavaScript AST replace line matching; dynamic invocation, aliases, computed/string-built members, splatting, and parse failures must fail closed as specified by p11d. CMD/BAT commands are tokenized after continuation joining.
- Add an actual regex-only scanner source mutant: the exact crev4 regression assertion must fail. Existing four p11c source mutants remain required.

No Desktop NEVER-list expectation is changed or weakened.

Implementation/setup adaptations required by the same p11d dynamic-invocation ban (no assertion removed or relaxed):
- Production cleanup and broker paths call fixed commands directly; injected callbacks execute only through a Linux-guarded fixture function in the existing exact owner. Windows cannot use this callback executor.
- Fixed observer, bridge and gate-setup native compilation moves to the existing owner. The Linux admission double and dry compilation setup use fixed owner functions; no arbitrary compiler API is exposed.
- The p11c historical-source fallback calls a fixed Linux-only owner helper. Its assertions are unchanged. The safety fixture loads the real publication functions via a static DefineOnly path instead of scriptblock creation.
- The prior preserve-running-wrapper mutant anchor follows the equivalent fixed clock call. The same mutation and failure assertion remain required.
- Build preparation's existing git/pnpm native calls now use the same job owner, with exit-code checks and a fixed one-hour build deadline. CMD arguments reject shell expansion/metacharacters. No signing or build operation is executed by this job.
