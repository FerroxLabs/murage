# D2 r3 classifier regression fix

Base: `4e7106495696385319c45e9e2e6eee81c543f1a5`. Static inspection only;
no build, test, Node/npm, network, live application/data access or commit.
`hz-v.txt` contains 873 failures in **four** test files, not seventeen
(`Test Files 4 failed (4)` at line 9300). The other reported suites and
property-test failures have no detailed failure output in that supplied log.
No passing count, typecheck, or application verification is claimed here.

## Root causes and changes

- `checkCompoundChild` was called for every simple command but unconditionally
  required the newly optional `stopLinePlace`. Legacy policy callers supplied
  the already classified `stopLine`, or no context for a pure mode decision.
  Even `ls` therefore became `unread-call`, ahead of the key and stop guards.
  Omission now preserves that policy API; explicit presence with an unavailable
  value still fails closed. The live execution call in `server/index.ts`
  supplies the property, so it still runs every child/effect check. Newly
  supported PowerShell block/foreach/Start-Process and cmd set/for-f boundaries
  carry a requirement through forks and cannot use the legacy API without
  supplying the place. Bound child key paths are checked in the legacy API too.
- The D2 replacement of `substituteLead` discarded the existing finite literal
  bindings, loop alternatives, and function positional arguments. Restoring
  that modeling recovers both ordinary commands and `delete-home`/`delete-root`.
  Computed executable paths still ask after any specific catastrophe is read.
  A slash alone no longer labels a native executable such as `/usr/bin/git` an
  unseen script; script extensions and interpreter/source inputs retain G4.
- Bare cmd/PowerShell launchers with no supplied code were conflated with
  explicitly requested unseen stdin. The latter, including supplied remote
  stdin, still asks; `cmd || true` and redirected bare `cmd` regain their old
  classification.
- PowerShell's new member rejection ran before the assignment RHS, hiding its
  named catastrophe; generic projection handling also rejected expandable
  strings beginning with several substitutions. RHS catastrophes now take
  precedence, strings remain data after their executable children are walked,
  and arbitrary member assignments still ask. Existing literal filters are
  walked with file-list provenance; their already walked blocks are not
  reconstructed as unknown scalar arguments in the child pass.
- Command evidence now snapshots state before source/opaque effects mutate it.
  This preserves the source command's actual cwd in the venv G4 shape.
  Nested cmd consumes its original `/c` tail rather than re-quoting tokenized
  fragments and losing interior quotes.
- The outer key reason precedes a child context/reconstruction failure.
  Shared sensitive paths now include Murage's `credentials.bin` on both
  platforms; the supplied controls named files absent from that registry.

## Continuation review

- Retained the partial root-cause repairs above. Restored the PowerShell
  argument/RHS member-access guard after finding that the partial repair had
  removed it too broadly. Only known file-item `.Name` and a file filter's
  `$_.Length` are modeled; arbitrary getters still ask.
  Quoted `"$x.Name"` remains interpolation plus literal text. An unsupported
  assignment target still permits its RHS catastrophe to retain its own rule.
- Legacy policy callers now check bound redirect targets with the shared key
  guard too. A new boundary containing only literal-output effects still
  requires its place even when it emits no executable record.
  A cached-clean outer stop cannot waive a discovered payment/message child;
  only a positive standalone stop can use the legacy preclassified decision.
- Preserved both string and array Start-Process attack wrappers while fixing
  their payload dialect. Added regressions for member getters, bound secret
  redirects, effect-only boundaries, literal commands and function arguments.
- `git diff --check` passed. HEAD remains the requested base. No runtime or
  typecheck was run; the previous gate's clean TSC predates these edits.
  `ijfw_memory_prelude` is not available in this session's tool inventory;
  the local project journal contains only a session-end marker.

## Every changed existing test expectation or input

1. `always-ask.test.ts`: `$(dirname "$(pwd)")/run.sh` moves from ordinary to
   unreadable: D2 does not infer executable paths from computed output.
2. The same file: `Get-ChildItem; bash -c 'rm -rf ~'`, `Get-ChildItem; wsl rm -rf ~`,
   and `cmd /c "wsl rm -rf ~"` now expect `delete-home`;
   `Get-ChildItem; wsl -e rm -rf /` expects `delete-root`;
   `cmd /c "sudo rm -rf /usr"` expects `delete-system-folder`.
   D2 reads these foreign execution bodies, so generic unreadable is obsolete.
3. The same file: `Get-ChildItem; bash -c 'echo hi'` and
   `Get-ChildItem; wsl --list` move to ordinary for that same reader expansion.
4. The same file: the three remote execution rows (download-and-source,
   download-and-sh, and curl/tr/bash) move from ordinary to unreadable.
   D2's remote-input control explicitly forbids authorizing unseen fetched code.
5. `auto-approve.test.ts`: `env.cmd git status` and `command.bat git status`
   retain their no-program-grant assertions but now require an always-ask
   result at Ask/Auto. They are literal unseen scripts under G4.
6. `compound-read-109.test.ts`: the unknown-executable control now binds
   `cmd=$unknown` instead of the known literal `cmd=echo`. The user's fix
   requirement preserves existing literal bindings; unresolved names still ask.
7. The same file's wrapper matrix preserves the payload's dialect with an
   explicit interpreter when crossing shells. The original matrix pasted
   POSIX assignments, quoting and tildes into cmd, or PowerShell syntax into
   bash, where they need not perform the asserted dangerous action. No
   must-ask assertion is removed. Windows Python/Node secret parity uses
   `cat .env`, as the other cmd shapes do, rather than a PowerShell cmdlet.

The new regression fixture covers ordinary commands through both policy and
execution contexts, named catastrophes, missing execution context, bound keys,
new-boundary context requirements, unseen stdin, remote input and unknown
names/member assignments. It has not been run. The gate must run the reported
suites plus this fixture and perform any workflow verification in an isolated
fixture as required by `docs/verification/README.md`.
