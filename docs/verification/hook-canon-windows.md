# Native Windows hook-canon T25

Run from the pushed checkout as an ordinary **non-elevated** Windows user with
Node 24 and the repository dependencies. This suite records actual fsutil
stdout, stderr, exit status and argv. Keep the complete test output with the
commit SHA and `whoami /all`. Linux skips these native cases and cannot establish
this evidence; the portable gate-selection assertion still runs there when the
file is selected explicitly.

The test creates isolated ordinary file/folder, junction and ACL fixtures. It
removes the ACL deny in `finally`. Junction creation uses Node's Windows junction
operation (equivalent to `mklink /J`), without requiring symlink privileges.
Timeout is deliberately a fault seam. No query result is injected into the
ordinary, junction, cloud or ACL cases.

## Prepare the separate non-junction cloud fixture

OneDrive must be signed in with Files On-Demand enabled. In PowerShell, create a
new disposable directory under that account's OneDrive, never reuse user files:

```powershell
$fixture = Join-Path $env:OneDrive ('murage-t25-cloud-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $fixture | Out-Null
$cloud = Join-Path $fixture 'murage-t25-cloud.cjs'
[IO.File]::WriteAllText($cloud, "module.exports = 'canonical';`n", [Text.UTF8Encoding]::new($false))
```

Wait for OneDrive to finish syncing. In Explorer choose **Free up space** on
this new file, then verify its online-only status (cloud icon). This operation
creates the cloud placeholder; `fsutil reparsepoint query` only inspects one.
Capture `fsutil reparsepoint query "$cloud"`. It must show a non-symlink,
non-junction tag (typically a CLOUD tag); a junction or ordinary file does not
qualify. Do not read the file's contents before the test and hydrate it again.

Set the dedicated fixture path and run all native rows:

```powershell
$env:MURAGE_T25_CLOUD_FILE = $cloud
node node_modules/vitest/vitest.mjs run server/hook-canon-windows.test.ts --reporter=verbose
```

The suite fails on Windows if this fixture is absent or is not a non-junction
reparse entry. The cloud test intentionally moves the placeholder aside and
restores canonical bytes at the original name. The disposable directory stays
in place for inspection; record its listing and the moved entry's fsutil output,
then delete only that exact fixture directory. Provision a fresh placeholder for
each rerun. An unavailable OneDrive/non-junction fixture is missing evidence,
not a passing native T25 result.

## Required named results for MAIN

File: `server/hook-canon-windows.test.ts`, suite `T25 native Windows (non-elevated)`:

- `runs as a non-elevated user`
- `ordinary file and folder are clean and unchanged`
- `junction is moved aside and restored without changing its target`
- `cloud non-junction reparse file is moved aside and restored`
- `ACL read-attributes denial is unknown and permits no repair mutation`
- `timeout is unknown with zero mutation (changed false)`
- `timeout is unknown with zero mutation (changed true)`

Also run the portable `T25 native Windows cases are selected by the Windows gate`
assertion. Keep raw outputs, pass/fail counts and the exact SHA. A native failure
needs investigation; replacing it with a classification seam is not evidence.
