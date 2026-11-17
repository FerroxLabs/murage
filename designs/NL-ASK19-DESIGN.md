# NL-ASK19 design note: reader shapes that still hold under No limits (1.0.19)

Status: DESIGN ONLY. No verdict was changed. Every shape below lets a command through that is held today, so it is a
widening and needs Fable and Astra to agree before any build. Author: NL-ASK19. Base: 40b87b6ef (1.0.18 final).
Scope note from the coordinator: the broader "unreadable runs unless it shows a catastrophe signal" widening belongs to
the Opus design NL-UNREAD-1019. This note feeds that design; it does not compete with it.

## 1. Evidence

Sean's live server.log, 11-03 to 11-09 (counts re-measured from the log):
- reason=unreadable: 180 origin=owner, 51 routine; `reader=held level=no-limits` 125, `level=auto` 25; `held=unread` 150.
- Most asks come from five bots (ac13a303 82, 10e51686 42, e575bbc8 30, 01b9d0ea 23, 980a5c80 18). ac13a303 is the
  heavy one, not Finch-by-id (unconfirmed).
- The log carries `why=` only on the newest lines (2 tokenizer, 1 value-path). The command text is never logged, so the
  exact shapes cannot be read back from the log. This is itself a gap: see section 5.
- sensitive-guard key rows in the log are mostly `env` (unmodeled/path/mcp) and `ssh`; harness-keys 5, credential-files 1,
  fuigo-engine-config 2. No command text, so no false positive can be PROVEN from the log. No change made to those rows.
- `unread-call:truncated` is a Write/Edit input where any one string value passes 2048 bytes (`TOOL_INPUT_VALUE_MAX_BYTES`)
  or the whole input passes 16 KB. A shell `command` is never value-capped. It is a card-display cap, not a reader limit.

## 2. Where it is decided

- Reader: `server/always-ask.ts` `readWhole` -> `server/shell/{lex,parse,walk,marks}.ts`. A failure is an `Unreadable`
  (lexer) or a `Doubt` (closed-list doubt in `marks.ts`/`walk.ts`) and becomes `unreadableHit()` with `doubt`.
- Verdict: `server/auto-approve.ts` ~1030-1100 (`ownerMarks(() => lax(read))`, the unseen-script cover at ~1063).
- Card class: `bulkEligibility` in `server/approve-all.ts` (`unreadable-held` is never bulk).

## 3. Corpus (about 190 ordinary bot shapes, probed through `alwaysAskCommand` with a real cwd and disk stub)

Read correctly (no hold): pipes, `&&`, `||`, `;`, quotes of every kind, `$(...)`, backticks, `$((...))`, `${X:-d}`,
`${#X}`, `${X%.t}`, `${X/a/b}`, `${arr[0]}`, `${X:0:3}`, `${X^^}`, `{a,b}`, `{1..5}`, `$'...'`, heredocs (quoted and
bare, inside `$(...)`, with `cat >`), `<<<`, here-pipes, `for`/`while`/`case`/`if`, functions, subshells, `diff <(..)`, `exec 2>&1`,
`git`, `npm`, `pnpm`, `cargo`, `go`, `make`, `python3 -c`, `node -e`, `python3 - <<EOF`, `jq`, `curl`, `find`, `xargs`, 20 KB
quoted text, 600 words, multi-byte text, `rm -rf ./build`, `rm -rf node_modules/.cache`. Length is not a cap in practice:
the lexer cap is 256 KB (`MAX_TEXT_CHARS`), the command gate 131072 chars.

Still held (all are DELIBERATE closed-list doubts, not parser bugs):

| Shape | Doubt | Why it holds today |
|---|---|---|
| `sed -i 's/a/b/g' file`, `sed -i '' ...` | tokenizer (marks.ts checkSed: "in-place and unknown options hold") | in-place is a write the reader does not model |
| `perl -pe '...' file` | tokenizer (walk.ts M-R1-interpreter-option) | perl/ruby option other than `-e` |
| `export PATH=$PATH:/dir && ...` | tokenizer (marks.ts STARTUP_ENV includes PATH) | startup/exec-selecting env names |
| `FOO=1 node a.js`, `NODE_ENV=production node server.js`, `env FOO=1 node a.js`, `nohup node a.js &` | opaque unseen script, not admitted | `shapeScript`/`coreShape` admit one bare script run only; an env prefix or `nohup` drops the `unseenScript` cover |
| `./run.sh`, `chmod +x run.sh && ./run.sh` | command | relative-path exec of an unseen file |
| `bash run.sh` (bare name) | unseenWhy=no-slash | placement rule |
| `eval "$X"`, `sh -c "echo $X"`, `${!X}`, `${X@Q}`, `rm -rf $VAR/foo`, `{1..5000}` | value-path | values that choose code or a delete target (correct to hold) |
| `echo a &&`, `echo a;;`, `echo (` | syntax | malformed (correct to hold) |

## 4. What I propose, each a widening (needs Fable + Astra)

W-A. `sed -i` with a literal program that `sedProgramReadable` accepts and literal file operands: read it as a write to
each operand and run the SAME write-target checks every other writer gets (protected paths, wipe list, key rows, outside
turn). Hold on: `-i` suffix forms the reader cannot spell, any `w`/`e` flag, a non-literal operand, no operand. Equivalence
test: for every corpus text, marks superset of base; protected-path operand still holds.

W-B. Env prefix on an admitted shape: `NAME=value <admitted script run>` and `env NAME=value <..>` where NAME is NOT in
`STARTUP_ENV` (never PATH, HOME, LD_*, NODE_OPTIONS, PYTHON*, GIT_*, etc.), value literal. Admitted exactly where the bare shape is
admitted today (same placement checks). `nohup`/`time`/`timeout N` prefix: separate row, same rule. This is a separate
whitelist row with an equivalence test, as CLONED-CWD-R9-RULING section 7 requires ("its own whitelist row with an
equivalence test, or it stays fail-closed"). NOTE the A1-1 interpreter list names `env` + interpreter: W-B must state it
amends only the unseen-script admission, not the W1 cwd relief.

W-C. `export NAME=literal` / `export PATH=$PATH:/literal-dir` is the one I do NOT recommend: PATH is a startup/exec
selector. Leave held.

W-D. `./run.sh`: leave held (unseen file executed by name). Covered by NL-UNREAD-1019 if it widens unreadable generally.

W-E. `perl -pe`: leave held (an interpreter option; interpreter rules stay).

Verified recommendation: build W-A and W-B only, behind the equivalence tests; leave W-C, W-D, W-E held; leave every
sensitive-guard row alone (nothing proven). If NL-UNREAD-1019 lands the catastrophe-signal widening, W-A and W-B are
subsumed for owner No limits and only matter for `auto` level (25 of the 150 asks).

## 4b. Astra r1 (acct5, read-only, reviews/nlask19/astra-r1.md): folded qualifications

- The "still held" table mixes three mechanisms (closed-list doubts, unseen-script admission failures, malformed syntax); the
  word "all deliberate" is too strong. The probe results are mine, from a vitest run on hz, and are unverified by Astra.
- W-A is not safe as specified until it names: backup-suffix targets (`-i.bak` adds a second write target), symlink behavior,
  and the exact option/program grammar. W-B needs: prefix composition, option boundaries, wrapper arguments, a policy reason
  why a literal env value outside STARTUP_ENV cannot change what an unseen script does, and one rule each for nohup, time, timeout.
- W-C: `export NAME=literal` and PATH mutation are different cases; only PATH (and the other STARTUP_ENV names) is held for the PATH reason.
- Approve all: the 1.0.18 reading is right, but the log counts do not prove what Sean's screen held; and a reader fix may make
  the commands run without a card at all, so the button would not "come back" so much as have fewer cards to cover.
- A general unreadable widening (NL-UNREAD-1019) does not automatically keep W-A's newly modeled write-target checks; they must be kept explicitly.
- Open from the ruling itself: A1-4 vs A1-1 (the reported `bash hello.sh` case is excluded by the interpreter list); not this lane's to settle.
- Status: Astra r1 DISAGREE on W-A/W-B as written, AGREE on holds W-C/D/E and on the Approve all reading. Fable has not reviewed. Nothing is built.

## 5. Non-widening changes safe to build without agreement (not built here; proposed)

- Log the command-free shape class on every unreadable ask: `why=` is only on the newest lines. Put `why=<doubt|unseenWhy>`
  on all of them, plus `shape=<first-word class>` (never the text). Without it the next round of this work is guessing.
- Show the owner the real reason on the card (already `readerWhyOf`); no change.

## 6. Approve all (second report, same release)

Not a regression to revert: it is a ruling. APPROVALS-SIMPLE-1018.md line 29: "The button reads Approve all {n} ... shows
only when n is 2 or more. `n` counts the rows on screen: GET /api/inbox stamps every request item with bulk ok or a
reason" (Astra r1 H4: the button never says a number it would not approve). 1.0.17 counted all approval rows
(`eligibleHint = result.approvals`); 1.0.18 counts only rows the server stamps `ok` (commit 950bb4b91, Inbox.tsx 645-667,
`approveAllHint`). Held reads (`unreadable-held`, sensitive, destructive) are never `ok` (`approve-all.ts` `bulkEligibility`),
so a list made mostly of held reads shows fewer than two ok rows and the button is absent. Sean's list is exactly that
(125 of 150 asks are `reader=held`). The reader fixes above are what bring the button back; reverting the count would make the
button promise rows it would refuse. Nothing restored. If Sean wants the button visible with a disabled "0 ready" state,
that is a new design (UI), not a revert.
