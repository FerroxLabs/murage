# LEASE-REAP-RELAUNCH-107 (r3): Murage cannot reopen after a terminal launch hangs (Linux / WSL)

Status: DESIGN r3 (r2 + Grok leasereap-design-r1 REVISE items), for Grok review before code. Base dev/int/104-rc1 099d47a0f (code at the line numbers below). Target 1.0.7 (int/107).
Field: muragetraining "Beast" (WSL Ubuntu, 1.0.3 .deb). Repro: hetzner-dsm container, PID 1 = `sleep infinity` (does not reap, like WSL init), launched as a job of an interactive shell on a pty. Evidence is in `lease-reap-evidence/`.

## Cause (proven)

Two defects chain together. Neither one is in the reap path; no code sends a signal to a PID it read from `.lease.child` or `reap-*`.

1. **The login-shell env probe takes over the launching terminal.** `server/env-path.ts:338-353` (`runCapture`, the same code in 1.0.3 `:336-339`) runs `execFile(shell, ["-l","-i","-c",…])`. It is not detached, so bash shares the session and process group of Electron main and the server child. Forced `-i` makes bash open `/dev/tty` and start job control:
   - It calls `tcsetpgrp` and takes the terminal's foreground. Murage's group becomes a background job.
   - If a slow or hung profile makes the probe outlive the 5 s timeout, SIGTERM does nothing (interactive bash ignores it). That bash then keeps the terminal. The field saw this survivor: pid 2344327, 4 minutes old.
   - The next probe starts while Murage's group is in the background. Bash's job-control setup does `kill(0, SIGTTIN)`, which stops **the whole Murage group**: main, the server child and the probe (state `T`, shell prints `[1]+ Stopped`). The window is frozen or blank. This is "first instance hung, needed kill -9".
   - Boot also waits on the hung probe: the 8799 child never answers health ("did not answer /api/health within 60s"). The 18799 fallback child's probe is the one that stops the group. A later SIGHUP or SIGCONT from the terminal kills the child before it answers health, with no stderr line. These are field failures A and B.
2. **The lease counts a zombie as a live child.** `electron/data-dir-lease.mjs:400-407` (`processIsAlive`, `kill(pid,0)`; 1.0.3 `:420`), used through `ownerIsAlive` `:60` and `assertNoLiveChild` `:478`. After kill -9 (or the SIGHUP above), the server child is re-parented to PID 1. On WSL, PID 1 never reaps it, so it stays `Z` forever. `kill(pid,0)` succeeds on a zombie, so every relaunch's `claim()` guard `:546` throws `LEASE_CHILD_BUSY`. Main exits with code 0 and never forks. The installation cannot be reopened until someone moves `.lease.child` aside by hand.
   - Each recovery attempt also adds an immutable `.lease.child.reap-*` or `.lease.reap-*` file. That is the growing set of reap files the field found.

## Repro results (Hetzner, real 1.0.3 .deb, sha256 1232f4f6…87f)

| Step | Result |
|---|---|
| Probe in a terminal job, profile ok | Works; bash briefly takes the terminal foreground and gives it back |
| Profile hangs 75 s | 8799 child: no health in 60 s. 18799 child: whole Murage group `Tl` (stopped). Terminal exit: child "exited before answering", then main and child become zombies |
| kill -9 main during boot | Child becomes a zombie under PID 1; `.lease.child` names it |
| Relaunch ×4 | Main exits 0 each time, no `fork` line. `inspectDataDirLease` = `LEASE_CHILD_BUSY` with both the 1.0.3 and 1.0.6 lease modules |
| Move `.lease.child` aside | Opens and serves at once (with a non-hanging profile) |
| Clean SIGTERM quit | Child releases `.lease.child`; a leftover zombie is harmless |

1.0.6: no 1.0.6 package exists to install (CI only), so the full app was not run. On Linux, `runCapture` and `processIsAlive`/`ownerIsAlive` are byte-identical between b3b7412b8 (1.0.3) and dev/int/104-rc1 d8eebfa37 (1.0.6). The 1.0.6 lease module, run against the zombie state, also returns `LEASE_CHILD_BUSY` for both inspect and acquire. **1.0.3, 1.0.4, 1.0.5 and 1.0.6 are all affected.** Severity: Critical candidate ("can't reopen after a crash", Linux/WSL terminal launches; any Linux host whose PID 1 does not reap). Defect 1 alone is High on any Linux or macOS terminal launch with a slow profile.

## Trigger, re-checked (r2, 2026-10-26)
The probe stops only when the probe has a **controlling terminal**. The dotfiles do not matter.
- Gate box (Ubuntu 24.04, systemd PID 1, stock dotfiles), no ctty (`tty` = "not a tty"): `bash -l -i -c true </dev/null` exits 0 in 0.09 s, with or without `setsid`. Bash prints only "cannot set terminal process group / no job control". **A desktop launch is not affected.**
- The same box under a pty, in a background group (`timeout 8 bash -l -i -c true`): bash goes to state `T` and stays stopped for more than 127 s, until it is killed; timeout's SIGTERM does nothing. With `timeout --foreground`, `setsid -w`, or no `-i`, it exits in 0 s.
- Beast "stock dotfiles hang 20 s via sudo, no TTY": sudo keeps the caller's controlling tty, and timeout(1) without `--foreground` runs its command in a background group. This is the same mechanism (bash's job-control init opens the tty and gets SIGTTIN). A hung profile only makes it worse.
So F1's trigger is any launch with a controlling tty: a terminal launch, `sudo`, `nohup` from a shell, or a WSL shell. Severity stays as above.

## Fix design

### F1. The probe never has a controlling terminal (server/env-path.ts `runCapture` :338-353)
- Replace `execFile` with `spawn(shell, ["-l","-i","-c",script], { detached: true, stdio: ["ignore","pipe","pipe"], env })` on POSIX.
  - `detached` means `setsid()`: a new session with no controlling tty. Bash cannot open `/dev/tty`, so there is no `tcsetpgrp` and no SIGTTIN, against either Murage's group or the probe.
  - stdin is `/dev/null` (`ignore`). Today it is a pipe that is closed at once, so behaviour does not change.
  - This is the same rule as env-path.ts:734-736 (the `--version` probe) and procs.ts Rule 74c.
- **Keep `-i`.** Env parity needs it: stock Ubuntu `.bashrc` returns early unless the shell is interactive, and PATH exports in `.bashrc` or `.zshrc` (nvm, ~/.local/bin, ~/.kimi-code/bin) load only with `-i`. Rule 74a captures "the owner's terminal" environment. With no tty, `-i` costs only the two warning lines on stderr, which are discarded.
- **Timeout** (CAPTURE_MS, 5 s): resolve at once with `{cause:"it took too long"}`, destroy stdout and stderr, and SIGKILL the group with `process.kill(-child.pid, "SIGKILL")`. SIGKILL is used because interactive bash ignores SIGTERM and a stopped process cannot act on it. Do not wait for `close`: a profile that daemonised itself into another session can hold the pipe open for ever. **PID-reuse guard:** the group is signalled only while the leader is still unreaped (`child.exitCode === null && child.signalCode === null`, with no `exit` event yet). Until Node reaps it, the kernel keeps its PID (and so its PGID) reserved, so `-pid` can only name this capture's own group. Node reaps on the same event loop that runs the timer, so the check cannot race. Once the leader has been reaped, nothing is signalled: the streams are destroyed and the capture resolves. A group-kill error such as ESRCH is ignored.
- **Output cap** (CAPTURE_BYTES): the same guarded group SIGKILL, resolved as "its output could not be read whole".
- **Normal exit**: resolve on `close` with the exit code, and parse it as today. Nothing is killed after a successful capture: background jobs a profile starts (ssh-agent and the like) keep today's behaviour.
- **Spawn error** (ENOENT, EACCES): resolve as "the shell exited with <code>", as today.
- The `pid` used for the group kill is the one this capture spawned. It is held in the closure and is never read from disk. A capture whose generation was invalidated still owns its own child: its timer still kills only its own group. That covers two probes at once.
- **Windows**: `runCapture` is reached only with an explicit `options.shell` (tests). No `detached` on win32, because it would open a console window. Keep today's path there.
- **Boot does not wait on the probe (verified, no change needed):** `augmentedPath()` (:166-186) starts `void captureOwnerEnv()` and returns synchronously. `server.listen` (index.ts:30271) waits only on `releasePreListenHealth()`. Only engine spawns (`handedEngineEnv`) and Engines "Check again" await the capture. The field's missing health answer was the group being stopped (SIGTTIN), not an await. A regression test pins this (see Tests).

### F2. Liveness treats a zombie and a reused PID as dead (electron/data-dir-lease.mjs)
- **Zombie** (`processIsAlive` :400-407): Linux only. After `kill(pid,0)` succeeds or returns EPERM, read `/proc/<pid>/stat`. Its shape is `pid (comm) state f4 … f52`, and comm can contain spaces and `)`. Parse it as: take the text after the **last** `)`, which must start with whitespace, then split on whitespace. Token 0 must be one letter (the state, field 3), and token 19 must be a decimal integer (the starttime, field 22). Any other shape counts as unreadable. Only a well-formed state of `Z` or `X` means dead. Any read or parse failure keeps "alive" (fail closed), so a missing `/proc` can never make an owner dead. Every caller gets this: primary, child, reaper, delegation parent and inspection.
- **Start time / PID reuse**: Linux identity **version 3**, `{version:3, pid, token, start}`, where `start` is starttime (field 22, i.e. token 19 after the state, parsed as above; clock ticks since boot) as a decimal string matching `^[0-9]{1,20}$`. It has its own validator, not Windows' `validStart`, which rejects "0" and caps at FILETIME. It goes in the existing token-scoped sibling file `<record>.identity-<token>`, not in the owner record:
  - Owner records stay version 1 with the same strict keys, so 1.0.3-1.0.6 can still read and validate a 1.0.7 record (two installs, downgrade). Older builds' `isIdentity` rejects v3, so their `readIdentity` is null and they keep PID-only behaviour, which is today's.
  - `recordOwnIdentity` on Linux publishes v3 after the claim, for the primary and for the delegated child alike. No held file is used: that is Windows only.
  - `creationIdentityDisproves` on Linux: read the v3 identity. If the live PID's starttime parses cleanly (the same parser) and **differs** as a string from the kernel's canonical decimal, the owner is dead (PID reuse). An unreadable value, a missing identity or a malformed identity means "not disproved" (fail closed). Legacy records with no identity keep PID-only behaviour.
  - It is evaluated where the record path is passed today: primary claim and retire, child guard, inspect. It is not used for reapers or the delegation parent; there the zombie check applies.
  - `removeIdentity` removes the v3 file on release or retire, as it does today for v1/v2. A v3 file left behind by a crash is inert and token-scoped, like the other leftovers.
- No signal is ever sent to a PID read from a record. This is unchanged.
- **macOS**: no change. There is no `/proc`, and launchd reaps orphans. **Windows**: no change; the v1/v2 identity paths are byte-for-byte as before.
- A stopped (`T`) orphan is still refused with `LEASE_CHILD_BUSY` (it can resume and write). r2 drops the r1 recovery-page wording change: with F1, Murage can no longer stop its own group. A user's Ctrl-Z is deliberate, and the existing message ("a delegated server is still using this installation") is still true.

### State machine (per data dir; primary P, child C)

```
FREE --main claim--> P_HELD --fork+delegate--> P_HELD+C_HELD --child exit/release--> P_HELD --main release--> FREE
P_HELD+C_HELD --main crash / kill -9 / SIGHUP--> C_ORPHAN(alive|stopped|zombie|gone)
C_ORPHAN(gone ESRCH | zombie Z/X | start mismatch) --next claim: child guard says dead--> P_STALE --retire P (reaper)--> FREE --> claim
C_ORPHAN(alive running S/R/D | alive stopped T | /proc unreadable) --next claim--> refuse LEASE_CHILD_BUSY, record kept, no signal (a possible writer)
P_HELD --main crash, no child yet--> P_STALE --next claim--> retire P --> claim   (unchanged)
C dead and its record left (guard ignores it) --> removed by the next child claim's retire (acquireDataDirLeaseForProcess), as today
P_STALE(P zombie | P start mismatch | P gone) --> retired by the immutable reaper chain as today
```

### Failure list (each is a test or a repro row)
1. Zombie child under a PID 1 that does not reap → retired, and the relaunch opens. (The field case.) Test plus Hetzner repro.
2. Zombie primary → retired. Test.
3. Stopped (`T`) orphan child → refused, never retired. Test.
4. PID reused after a crash → the v3 start mismatch retires it. A legacy record with no identity, on a live PID, still refuses. Tests.
5. `/proc/<pid>/stat` unreadable or garbled → alive (fail closed); a missing start → not disproved. Tests (the reader is injectable).
6. kill -9 of main during boot → the child is orphaned. If it is gone, or a zombie under a non-reaping PID 1, it is retired (repro). If it is still running (`S`/`R`; `utilityProcess` children outlive a killed main), it is a live writer: refused with `LEASE_CHILD_BUSY`, its record kept and no signal sent (test).
6a. Primary crash before any child exists → the primary is retired by the reaper chain (unchanged, existing test).
7. Hung login profile under a controlling tty: the probe never takes the terminal, never stops main, and never delays first health. The timeout SIGKILLs its whole group within CAPTURE_MS plus a small margin. Test plus repro.
8. Two probes at once (generation invalidation): each kills only its own group, never Murage's group or the other probe's. Test.
9. Terminal closed (SIGHUP) while the app runs from it: the probe is in its own session and gets no SIGHUP. Main and child follow today's SIGHUP path. A child left as a zombie is item 1. Repro row.
10. Two installs, or a downgrade, sharing a data dir: the record format is unchanged; v3 identity is ignored by older builds, which stay PID-only (today's behaviour). Analysis.
11. Windows and macOS: no behaviour change. Tests: the existing Windows identity tests pass unchanged, and macOS `processIsAlive` never reads `/proc`.
12. Desktop launch (no ctty): the spawn changes (detached, plus the group kill on timeout) for every POSIX capture. What the user sees does not change: the gate-box data above shows the same 0.09 s and exit 0 with or without setsid, and the same environment comes back. The env-path tests run with no ctty.
13a. Reaper PID reuse: reaper records stay PID-only plus the zombie check (no identity, as today). A reaper lives only across one retire, and a reused live reaper PID gives `LEASE_RECOVERY_BUSY`, which fails closed. That is unchanged and not made worse.
15. Probe timeout after its leader exited (a grandchild holds the pipe): no signal is sent (PID-reuse guard), and the capture resolves.
13. Reap-record growth: one immutable file per recovery, as today; bounded by MAX_REAPER_GENERATIONS. No pruning in this lane.
14. The real-app repro (non-reaping PID 1, pty job, hanging profile) becomes a Linux gate row on the 1.0.7 package.

### Tests (fix/107-lease-reap)
- electron/data-dir-lease.node-test.mjs (Linux-only rows skip elsewhere): a real zombie child record is treated as dead (a forked child is left unreaped by a helper parent that ignores SIGCHLD but does not wait); a zombie primary; a stopped `T` child is refused; a v3 identity with the wrong start is retired while the unrelated live process is untouched; a v3 identity with a matching start stays exclusive; legacy no-identity live PID → busy; a running orphan child → busy, record kept; unreadable, garbled or zombie-looking-comm stat → busy; acquire publishes v3 and release removes it.
- Liveness on Windows and macOS is unchanged: the existing Windows identity tests pass unchanged, and a test on darwin and win32 asserts that `/proc` is never read.
- server/env-path.test.ts (POSIX): a shell that sleeps 60 s resolves "it took too long" within CAPTURE_MS + 2 s, and its whole group, including a grandchild, is gone afterwards; the spawn is `detached` (the probe's sid differs from the test's sid, and it has no ctty); two overlapping captures kill only their own groups; a capture whose leader exited but whose grandchild holds the pipe resolves at the timeout and sends no group signal; `augmentedPath()` returns synchronously while a capture hangs; index.ts's listen chain does not await `captureOwnerEnv` (a source guard).
- Hetzner repro, before and after: a container with PID 1 = `sleep infinity`, `script` pty job, a profile that hangs 75 s, kill -9 main, relaunch ×3.

## Beast checks (read-only, for the training team; main profile state preserved)
```
for f in ~/.murage-data-owner-*.lease.child; do p=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$f"); echo "$f pid=$p"; ps -o pid,ppid,stat,lstart,args -p "$p" 2>/dev/null || echo gone; done
ps -eo pid,ppid,pgid,tpgid,stat,etimes,args | grep -E 'murage|bash -l' | grep -v grep
time bash -l -i -c true </dev/null      # >5 s, or a hang, confirms the probe trigger
cat /proc/1/comm
```
Workaround until the fix: launch Murage from the desktop or start menu, not from a terminal. If it will not open, move the named `.lease.child` aside only once `ps` shows that pid as `Z` or gone.
