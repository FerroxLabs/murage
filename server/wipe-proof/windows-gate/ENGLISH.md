# Windows gate diagnostic inventory

Owners: wg-wincheck owns this inventory and the text checker; wg-winproof owns
the reference runner and Windows launcher. These are developer/test diagnostics,
not application UI strings. No product-facing English copy is added.

| Source | Exact diagnostic or template | Purpose |
| --- | --- | --- |
| `run.mjs` | `Windows text gate requires Node ${minimumNode}+ with native TypeScript support.` | Unsupported runtime |
| `run.mjs` | `Usage: node run.mjs [--summary FILE]` | Invalid arguments |
| `run.mjs` | `Expected all 240 reference rows.` | Reference completeness |
| `run.mjs` | `Invalid or duplicate reference id.` | Reference identity |
| `run.mjs` | `Invalid expectation: ${row.id}` | Verdict validation |
| `run.mjs` | `Missing command/reason: ${row.id}` | Reference completeness |
| `run.mjs` | `Invalid Windows fixture context: ${row.id}` | Isolated context validation |
| `run.mjs` | `Expected 119 CARD and 121 RUN rows.` | Verdict counts under MAIN 23:15Z(b) |
| `run.mjs` | `${passed ? 'PASS' : 'FAIL'} ${row.id} expected=${row.expected} actual=${actual}${rule ? \` rule=${rule}\` : ''}` | Per-row result |
| `run.mjs` | `FAIL gate setup: ${error.message}` | Setup failure |
| `run.mjs` | `isolated lexical Windows context; filesystem unavailable` | JSON fixture description |
| `run.mjs` | `Windows PowerShell 5.1`, `PowerShell 7`, `cmd`, `Git Bash` | Engine labels |
| `run-windows.ps1` | `This launcher requires Windows. Use node run.mjs for Linux classification evidence.` | Platform refusal |
| `run-windows.ps1` | `Cannot read the Node version.` | Runtime discovery failure |
| `run-windows.ps1` | `Node 24 or newer is required. Install Node 24+, then run this command again.` | Runtime remediation |
| `run-windows.ps1` | `Summary: ` followed by the output path | Evidence location |

`process.mjs` adds no English message. Its structured `stdoutOverflow` and
`stderrOverflow` booleans identify a stream exceeding 65,536 retained characters;
`error: true` also prevents a truncated execution from qualifying as a pass.
The stream prefix remains bounded and the child exit code remains unchanged.
