# NOLIMITS-WALK-CRIT (1.0.16 / 1.0.17): shell launchers fail closed

## The gap (live in 1.0.15 and 1.0.16, walk.ts blob be8f5156)
On an owner No limits turn only the always-ask reader can raise a card, and it raises one only when
`server/shell/walk.ts` reads the code or throws `Unreadable`. Three shapes got neither:
- `bash -oc errexit '$(rm -rf /)'`: `shellScript` saw `-oc` as a flag cluster with `c`, so it took the
  next word (`errexit`, the value of `o`) as the script and the real script as `$0`.
- `busybox sh -c '...'` and `tcsh -c true -c '...'`: neither name is in `SHELLS`, so their words were data.

## Rule (fail closed, tiny, linear)
A shell launcher raises a card (`Unreadable`, which always-ask holds at every level) unless its argv is
exactly `<shell> -c <script> [$0 args...]`:
1. `busybox`, `toybox`, `csh`, `tcsh` and a few shells the reader does not model (`rbash`, `yash`, `posh`,
   `oksh`, `loksh`, `pdksh`, `nu`, `elvish`, `xonsh`) always ask, whatever their words.
2. For `SHELLS`, the `-c` form is read only when the first argument word is exactly `-c` or `-lc`
   (exact string compare). Then: the script word must be plain and must not start with `-` or `+`; no
   later word may be exactly `-c`; more than 128 argument words asks. The script is scanned as today.
3. Any other option word that contains `c` (`-xc`, `-ec`, `-oc`, `-cs`, `+c`, `-c` after `-o x`,
   `--rcfile x`, `-x` and so on) asks. An operand that is exactly `-c` (after `--`) asks.
4. The option loop for the non-`-c` forms (`bash file.sh`, `bash -s`, stdin) is unchanged apart from a
   cap: past 64 option words it asks.

One pass over the words, exact string compares and `includes("c")` only, no helper called on data words.

## Why `-lc` stays readable (deviation from the strict brief, verified)
Codex reports every shell call as argv `["bash", "-lc", "<cmd>"]`, rendered `bash -lc '<cmd>'`
(server/approval-text.ts commandText). Carding `-lc` would card every Codex command at Auto, Full access
and No limits (auto-approve.test.ts:219 pins Auto approving `bash -lc 'echo hello'`). `-l` takes no value
in sh, bash, zsh, dash, ksh, fish, ash and mksh, so `-lc <script>` reads exactly as `-c <script>`; the login
startup files it reads are the ones the existing startup-file rules already cover (reader-loaders-105).

## Tests
server/nolimits-walk-crit.test.ts: every bypass and variant (`-oc`, `-xc`, `-ec`, `+o`, `--rcfile`,
`env bash -oc`, busybox, toybox, csh, tcsh, a second `-c`, an option after `-c`, the word cap) holds on an
owner No limits turn; `bash -c 'ls'`, `bash -lc 'ls'`, `sh -c 'git status'` approve as before, and
`bash -c 'rm -rf /'` keeps its delete-root card. Fails on base 170d78540, passes on head.
