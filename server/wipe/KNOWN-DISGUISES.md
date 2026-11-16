# Listed, not gating

Owners: wg-proof maintains this list and scope evidence; wg-text and wg-win
own literal text checks; wg-shim and wg-pwsh own exec interception;
wg-callback owns callback decisions; wg-wiring owns engine reach. MAIN owns
the release bar. Future interception mentioned below needs an assigned build
owner before implementation; it is not a claim that a future layer exists.

These forms come from both wipe designs and WIPE-GATE-BAR. Examples are
documentation, never harness payloads. They are deliberately unexecuted.
`/fixture/home` and `C:\fixture\home` stand for protected roots.
Plain or common literal forms in [SCOPE.md](SCOPE.md) still gate. Some rows
have literal forms already covered by text: only their computed/bypassing
variant is listed here. Fix listed forms as found and retain the example.

| # | Form and example | Why outside the gating promise | Layer that can catch it |
| --- | --- | --- | --- |
| 1 | less shell escape: `less '+!rm -rf /fixture/home' file` | Interactive pager grammar is not a promised host | Text escape row later; existing argv guard if spawned rm preserves PATH |
| 2 | editor escape: `vim -c '!rm -rf /fixture/home' file` | Editor command language is not shell source in the host table | Text editor row later; argv guard on resulting PATH rm |
| 3 | awk: `awk 'BEGIN {system("rm -rf /fixture/home")}'` | Embedded awk evaluation is not modeled | Text interpreter row later; argv guard on resulting PATH rm |
| 4 | AppleScript: `osascript -e 'do shell script "rm -rf /fixture/home"'` | Another host/language and possibly changed environment | Text AppleScript row later; argv guard only if PATH retained |
| 5 | git pager: `git -c core.pager='rm -rf /fixture/home' log` | Pager selection and launch conditions are outside fixed wrappers | Text git configuration row later; argv guard when launched through PATH |
| 6 | git alias: `git -c 'alias.z=!rm -rf /fixture/home' z` | Configuration-driven execution is not shell prediction | Text alias row later; argv guard when PATH retained |
| 7 | remote shell: `ssh host 'rm -rf /fixture/home'` | Local roots/environment cannot describe the remote machine | Guard installed on remote host or later remote-aware text check |
| 8 | container execution: `docker exec box sh -c 'rm -rf /fixture/home'`; exact bind variant: `docker run -v/home/tester:/h alpine sh -c 'rm -rf /h/*'` | Container filesystem/PATH is outside local seam | Host runtime guard does not see either container command (macOS, Linux or Git Bash); interception would have to run inside the container |
| 9 | cluster execution: `kubectl exec pod -- sh -c 'rm -rf /fixture/home'` | Pod filesystem and launch seam are remote | Guard inside pod; later cluster host row |
| 10 | script on disk: `sh cleanup.sh` with deletion in that file | No promise to read arbitrary files before execution | Existing argv guard if script uses PATH tools; otherwise later OS enforcement |
| 11 | encoded source: `powershell -EncodedCommand <base64-UTF16LE>` for `Remove-Item -Recurse C:\fixture\home` | Decoding payloads is a listed disguised tier, even if option is recognized | Later encoded-source text reader or child PowerShell proxy injection |
| 12 | decoded shell source: `printf %s <base64> \| base64 -d \| sh` | Arbitrary encoded data reconstruction is outside literal source | Existing argv guard for resulting PATH tools; later decoded-source reader |
| 13 | Python argv indirection: `python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1])' /fixture/home` | Literal code target comes from runtime argv, not the supported inline pattern | Later interpreter argv data-flow; OS enforcement for direct syscall |
| 14 | node argv indirection: `node -e 'require("fs").rmSync(process.argv[1],{recursive:true})' /fixture/home` | Direct runtime API argument flow bypasses PATH | Later interpreter argv data-flow or OS enforcement |
| 15 | Python two-level alias: `python3 -c 'import shutil; a=shutil.rmtree; b=a; b("/fixture/home")'`; exact code-tool import alias: `import shutil as s\ns.rmtree('/')\nx = 1 << 2` | Arbitrary alias analysis is outside literal interpreter patterns | Host runtime guard does not see these direct Python API calls (macOS, Linux or Git Bash); later interpreter alias analysis or OS enforcement |
| 16 | PowerShell constructed path: `Remove-Item -Recurse (Join-Path C:\fixture home)` | Text does not promise arbitrary path-expression evaluation | Existing top-level proxy resolves it; later text expression row or child proxy injection |
| 17 | interpreter built path: `python3 -c 'import os,shutil; shutil.rmtree(os.path.join("/fixture","home"))'` | Deliberately constructed interpreter paths are listed by the ruling | Later interpreter expression reader or OS enforcement |
| 18 | computed iex: `$a='Remove-'; $b='Item -Recurse C:\fixture\home'; iex ($a+$b)` | Literal iex is covered; arbitrary computed source is not | Existing top-level proxies if in same runspace; later computed-source reader |
| 19 | object method deletion: `(Get-Item C:\fixture\home).Delete($true)` | Member invocation does not call the Remove-Item proxy | Optional future text member row or OS enforcement |
| 20 | object method move: `(Get-Item C:\fixture\home).MoveTo('C:\fixture\backup')` | Member invocation bypasses Move-Item | Optional future text member row or OS enforcement |
| 21 | GNU parallel: `parallel rm -rf ::: /fixture/home` | `:::` job expansion is not a promised wrapper grammar | Existing argv guard on PATH rm; later parallel text row |
| 22 | PowerShell StrictMode: `Set-StrictMode -Version Latest; pwsh -c 'Remove-Item -Recurse "$x\*"'` | Do not infer strictness through arbitrary process boundaries | Actual top-level/child proxies where installed; later process model |
| 23 | cmd dynamic for input: `for /f %p in ('type roots.txt') do rd /s /q %p` | Runtime external producer/file contents are outside literal values | Later cmd execution interception; text only when producer is a resolved literal |
| 24 | expanded absolute tool: `p=$(cat tool-dir.txt); "$p/rm" -rf /fixture/home` | Absolute invocation bypasses PATH and the tool path comes from external state | Later OS/preload interception; resolved same-text tool variables stay in text scope |
| 25 | privileged or reset PATH: `sudo sh -c 'p=$(cat roots.txt); /bin/rm -rf "$p"'` | Privilege/environment reset plus computed target loses both local seams | Later privileged exec enforcement; literal su/sudo payloads remain text scope |
| 26 | child PowerShell computed target: `pwsh -comm '$p=Get-Content roots.txt; Remove-Item -Recurse $p'` | Child lacks top-level proxies and source value is external | Planned child pwsh/powershell injection; literal `-comm` forms already gate in text |
| 27 | module-qualified runtime path: `$p=Get-Content roots.txt; Microsoft.PowerShell.Management\Remove-Item -Recurse $p` | Module qualification bypasses the proxy and target is unresolved | Later text data-flow or OS enforcement; literal target stays text scope |
| 28 | direct .NET computed path: `[IO.Directory]::Delete((Get-Content roots.txt),$true)` | Bypasses cmdlets; text knows no external value | Later .NET pattern/data-flow or OS enforcement |
| 29 | unshimmed deletion with dynamic operand: `find "$(cat roots.txt)" -delete` | Local guard does not own find; literal find is still text scope | Later find exec shim or OS enforcement |
| 30 | dynamic sync deletion: `rsync -a --delete empty/ "$(cat roots.txt)/"` | Guard does not own rsync; external value is not literal | Later rsync exec guard; literal target remains text scope |
| 31 | dynamic git cleanup: `git -C "$(cat roots.txt)" clean -fdx` | Guard does not own git; cwd comes from external state | Later git exec guard; existing literal policy remains |
| 32 | dynamic device redirect: `cat image > "$(cat device.txt)"` | Shell performs redirection without a shimmed tool argv | Later shell/OS interception; literal device redirect remains text scope |
| 33 | PATH reordered by engine/startup: `PATH=/bin:$PATH sh cleanup.sh` | Execution no longer passes the installed shim | wg-wiring startup/PATH proof or later OS enforcement; text scope remains |
| 34 | link created then traversed in same command: `ln -s /fixture/home jump; rm -rf jump/` | Ruling explicitly lists command-created link disguises | Existing argv guard if canonical resolution sees it; later OS enforcement for races |
| 35 | direct interpreter API with runtime target: `python3 -c 'import shutil; shutil.rmtree(input())'` | PATH cannot intercept language filesystem APIs | Later interpreter data-flow or OS enforcement; literal direct APIs remain text scope |
| 36 | cmd built-in runtime target: `set /p p=<roots.txt & rd /s /q %p%` | No executable argv shim for built-ins and no known value | Later cmd process interception; literal/env-known built-ins remain text scope |

| 37 | attached sed script: `sed -ew/dev/sdz9 input` | MAIN 1114-WIPE-REVIEW-BOUND lists attached-script device writes, not gating | Later sed script reader |
| 38 | negated shell compound: `! if true; then rm -rf ~; fi` | MAIN 1114-WIPE-REVIEW-BOUND lists this compound grammar, not gating | Later shell grammar row |
| 39 | assignment fallback: `D=${V:-$(false)} || rm -rf ~` | MAIN 1114-WIPE-REVIEW-BOUND lists this expansion/status combination, not gating | Later shell status model |
| 40 | property expansion: `Get-ChildItem C:\fixture\home | Select-Object -ExpandProperty FullName | Remove-Item -Recurse` | MAIN 1114-WIPE-REVIEW-BOUND lists Select-Object -ExpandProperty sources, not gating | Later property provenance model |
| 41 | quoted POSIX child pattern: `rm -rf "/usr/*"` | MAIN 1114-WIPE-REVIEW-BOUND lists this literal-child carding issue, not gating | Later quoting/provenance correction |
| 42 | Deno sync API: `deno eval 'Deno.removeSync("/fixture/home",{recursive:true})'` | Interpreter API form found by the one bounded integration review; the async `Deno.remove` literal is read, the sync twin is not. MAIN final-closer brief: listed, not built | Later interpreter API row; no argv guard (no PATH tool is started) |
| 43 | Perl module import: `perl -MFile::Path=remove_tree -e 'remove_tree("/fixture/home")'` | Interpreter API reached through a `-M` import list; found by the same review. Listed, not built | Later interpreter API row; no argv guard |
| 44 | several empty-directory operands: `rmdir -p a/b c/d` reaching a protected parent | MAIN 1114-LANE-QUAL lists this callback form, not gating | Later callback operand model |
| 45 | KNOWN-CONSERVATIVE: `pwsh -Command Remove-Item -Recurse -Force "$HOME/*" -LiteralPath` cards although the trailing switch is malformed | MAIN 1114-WIPE-FIXTURE-DIRECTION item 1: the bound target is the whole home; the product is not loosened | None needed |
| 46 | KNOWN-CONSERVATIVE: with the parser and the recovery scanner both faulted, a printed `rd /s C:\` example cards as wipe-check-fault | Fault recovery reads raw text; only storage cmdlets and disk tools are read at quote-aware command boundaries | None needed |

Nounset across processes, ordinary loops/lists (including values past old
caps), variables and globs that reach shimmed tools, literal wrapper options,
and resolved PowerShell pipeline/relative-wildcard forms are **not** disguised
exceptions. Their designated layer must catch them. The five likely review
siblings from the text design (zsh long options/5.1 positional commands,
nonexported variables/functions, Get-Location pipelines, relative `'*'`, and
long or nested literal lists) remain inside that scope.
