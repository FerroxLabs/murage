# Native Windows Signal gates (MAIN)

Use the disposable Desktop checkout at `C:\murage-ci`, on an NTFS volume,
with native Node 24+, pnpm 10.33.0 and elevated **64-bit Windows PowerShell**.
The runner needs local-user creation, symlink/reparse privileges and full
language mode for fixture setup; the CLM case tests the production reader
separately in constrained language mode. No Signal login or runtime is used.

```powershell
Set-Location C:\murage-ci
pnpm install --frozen-lockfile --ignore-scripts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\win-signal-native.ps1
```

The script invokes native `node.exe node_modules/vitest/vitest.mjs run` with
`scripts/signal-runtime.test-config.mjs`, the two files and exact full names in
[`ci/gate-signal-native-windows.txt`](../ci/gate-signal-native-windows.txt).
It runs one log DACL case, CLM parity, inheritance repair, three link cases,
one non-link reparse case and four foreign-owner cases: **exactly 11**.

Expected final output: `11 passed / 0 failed / 0 skipped (selected gates)` and
exit 0. Vitest also lists unrelated cases as skipped by the name filter;
those are not qualification cases. Each of the 11 selected cases must appear
exactly once as passed in the JSON report; absent/skipped cases fail the runner.
Linux/container results do not qualify Windows.

Evidence is retained in `evidence\signal-native-windows\<run-id>\`
(`vitest.log`, `vitest.json`, and `summary.txt` on success).
Tests restore owners/remove reparse points in `finally` and delete temporary
fixtures. The runner removes its disposable local user and scratch directory
and restores the process environment even on failure. Dependencies already
provisioned in this checkout are retained; no app build output is created.
After MAIN collects evidence, if dependencies were installed solely for this
run, remove only `C:\murage-ci\node_modules` from this disposable checkout.
