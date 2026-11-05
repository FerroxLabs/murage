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

## r1b (2026-11-05): common `-c` spellings read again
r1 carded `bash -cl`, `-lic`, `-ic`, `-xc`, `-ec`, `-o errexit -c` (stop-line corpus gc-08..gc-13,
gc-argv-bash-cl expect them read, not held). Sean: No limits means it, so the reader follows them again,
narrowly. `shellCScript` accepts a `-c` form only when every word before the script is:
- a cluster `-[lixevu]+`, or exactly one cluster `-[lixevu]*c[lixevu]*` (one `c`), which must be the last
  option word; the next word is the script. Letter check (bash(1) "OPTIONS"/set builtin, zsh(1) +
  zshoptions(1) single-letter options, dash(1), ksh93(1), mksh(1), busybox ash, fish(1)): `l` login,
  `i` interactive, `x` xtrace, `e` errexit, `v` verbose, `u` nounset take no value and run no code in
  any of them; fish has no `x`/`e`/`u` (it exits with an error) and its `-v` prints the version and exits.
  Excluded because they take a value, read a file or change where the script comes from: `o` `O` (bash
  shopt, zsh option toggles), `p` (fish profile file, bash privileged), `d` `D` (fish debug values),
  `C` (fish init command), `s` (stdin script), `R` (ksh93 xref file), `T` (mksh tty), `n` and the rest.
- a pair `-o NAME`, NAME in {errexit, nounset, pipefail, xtrace, verbose, noglob} (set-only flags in every
  sh-family shell; an unsupported name makes the shell exit without running the script). Never in fish,
  whose `-o` takes a debug-output file.
Anything else falls to the option loop, which throws on any option word holding `c`, so these still ask:
`+` options, `-oc x`, `-xo x -c` (value after a cluster), `-cO x`, `-cp`, `-cs`, `fish -dc`, `fish -o x -c`,
`-cc`, a second `-c`, a script that starts with `-` or `+`, and the word caps (64 option words, 128 words).
`-i`/`-l` startup files are the ones the existing startup-file rules already cover (as on base).
Astra r1b review (acct3): fish's getopt gives `c` the rest of its word (`fish -cvi true` runs `vi`) and keeps
reading options after the script (`fish -c true --command=X`, `-C X`). Fixed: fish reads only `-c`/`-lc` first
(as r1) and any option-shaped word after a fish script asks. Not changed: `bash -ic` runs ~/.bashrc before the
script (Astra High, conditional). Base and live 1.0.15 read `-ic`, corpus gc-09/gc-10 pin it read, and `-lc`
(profile files) has the same exposure; on-disk startup files are outside this lane (NOLIMITS-LAUNCHERS).
