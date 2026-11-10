# OMB4 ownership candidate

This patch is a source candidate stacked on agent-browser v0.36.0 (`eb05921bad874cd2a1b4fa5d1149f1ed26576cae`). Windows applies stdio, token036, noconsole, ownership, in that order; other desktop targets apply token036, ownership. It is not a new published engine or an asset-pin change. Promotion remains gated by S2 section 15.5 and the native rows below. Cloud home remains on its existing engine.

A window CLI must receive `AGENT_BROWSER_LAUNCH_ID` (16 lowercase hex digits) and `AGENT_BROWSER_NO_XVFB=1`. `noXvfb` has no command-line flag: flags.rs reads it from that environment variable and main.rs includes it in the launch request. The daemon refuses a window launch without the explicit true request field. Window daemons also refuse recording, WebDriver, provider, stream-session and stream-tool spawns. `close-only` and `launch-group --owner-file PATH --status` are local maintenance commands; neither starts a daemon. Unix stop variants of launch-group are refused.

## Ownership references

These references pin the source used for the ownership argument. They do not certify an untested OS binary. The container host reports Ubuntu kernel `6.8.0-137-generic`; its distribution patches and every vendor runner's exact kernel/build still belong in that runner's receipt.

- POSIX.1-2017, XBD 3.299, [Process Group Lifetime](https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap03.html#tag_03_299): a group ends when its last member leaves, including by process-lifetime end or a group/session change. The controlling phrase is “last remaining process in the group”.
- POSIX.1-2017, XBD 3.300, [Process ID](https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap03.html#tag_03_300): identity is unique for the process lifetime: “unique positive integer identifier”.
- POSIX.1-2017, XBD 3.301, [Process Lifetime](https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap03.html#tag_03_301): lifetime ends when the ID is returned: “process ID is returned to the system”.
- Linux v6.8, [kernel/pid.c, lines 340–356](https://github.com/torvalds/linux/blob/v6.8/kernel/pid.c#L340): `__change_pid` checks every PID type before `free_pid`: `if (pid_has_task(pid, tmp)) return;`. Source SHA-256: `b0fa137e20740163864206a921421b3a9f17e0d53790d3a3472677257813515f`.
- Linux v6.8, [kernel/exit.c, line 1085](https://github.com/torvalds/linux/blob/v6.8/kernel/exit.c#L1085): the `WNOWAIT` path returns exit information before the transition to `EXIT_DEAD` and release. Source SHA-256: `c7a2878deada686a04be224f8b5185ad022a995a297229ff8b43e8c3b53f2af9`.
- XNU `xnu-10063.121.3`, [bsd/kern/kern_fork.c, lines 976–978](https://github.com/apple-oss-distributions/xnu/blob/xnu-10063.121.3/bsd/kern/kern_fork.c#L976): allocation excludes process, group and session IDs: `phash_find_locked(pid)`, `pghash_exists_locked(pid)`, `session_find_locked(pid)`. Source SHA-256: `1b44046c20179328800ba8e9296a0de6b71b70e430ac3e180946d5b9233962bb`.
- XNU `xnu-10063.121.3`, [bsd/kern/kern_exit.c, lines 3245–3246](https://github.com/apple-oss-distributions/xnu/blob/xnu-10063.121.3/bsd/kern/kern_exit.c#L3245): `reap_child_locked` runs only without `WNOWAIT`. Source SHA-256: `637b66ba2592ead59ee43cb74de584a76f043c0a1c93d961a00e4ef04b15b543`.

These facts support signalling a group only while its own unreaped leader is held. They do not authorize a signal using an old PID, SID, PGID, process-name match, or ancestry scan. Linux adopted children are opened by pidfd, checked for direct parentage, checked still live, and signalled through that held descriptor. Only kernel `ECHILD` establishes Linux tree exhaustion. Other process observations cannot supply that proof.

## Native rows still required

Keep the window unavailable on a target until its applicable rows pass. Record the exact engine digest, kernel/OS build, Chrome build, commands, process traces and outcome for each row.

| Row | Required targets and evidence |
| --- | --- |
| OMB4-OWNER | macOS arm64/x64, Windows x64, Ubuntu glibc, Alpine musl: owner before socket, Chrome identity before success |
| OMB4-GROUP | Same targets: Chrome/GPU/renderer/utility/crash handler membership, including every escape |
| OMB4-CLOSEONLY | Every target: quitting Chrome then close-only creates no Chrome process |
| OMB4-KILL9 / OMB4-ORPHAN | Unix observes orphan identities and never signals them; Windows last job handle closes the tree |
| OMB4-SID-REUSE / OMB4-ORDER | Linux and macOS: leader remains unreaped until the last group signal; cycle PIDs under load |
| OMB4-PANEL | Every target: native e2e; Windows no-console smoke remains required |
| OMB4-SAVE | macOS, Windows, Linux: one save; refused required save preserves the window |
| OMB4-SUBREAPER | Linux: double-fork and SIGCHLD-ignored helpers, with syscall traces proving signals only after adoption |
| OMB4-ESCAPE | macOS arm64/x64 and Linux: heavy browsing; enumerate helpers outside the group, including helpers without launchDir in argv |
| OMB4-STOPCHAN | Stop while the async runtime is deliberately wedged; status still answers during a bounded stop |
| OMB4-NODISPLAY | No DISPLAY or WAYLAND_DISPLAY: S2 refuses before spawn, no Xvfb. WAYLAND_DISPLAY only without XWayland: record actual Chromium startup outcome; a failed engine start must reach S2 `closed` with the hold retained |
| E22 / M-E4 native | Linux FUSE uninterruptible sleep: bounded `tree_lingering`, status responsiveness, repeat over the same held children, then exhaustion after release |
| E21 / M-E1 / M-E2 native | Small-pid-max isolated machine/container with syscall trace: reused non-members are never signalled |

The Wayland-only container fixture deliberately supplies an unavailable display socket. It proves failed-start cleanup, not operation on a real Wayland compositor. The native row must record both whether that host can open Chrome and whether an unsuccessful start reaches `closed` through S2.

## Review boundaries

Linux container evidence is not native promotion evidence. The unmodified native e2e suite includes public-site navigation; under the required empty network namespace those cases report `net::ERR_INTERNET_DISCONNECTED`. Their environmental failures and any poisoned test-lock follow-ons must be kept separate from a native E9 pass.

On macOS an unreadable process argument list remains `enumeration_failed`; no process age or wall-clock comparison is used to infer the absence of an escaped helper. A native run must establish whether the platform can supply the observations required for closure.

The Linux termination-denied fixtures exercise deadline and retry behavior using seccomp. They do not establish the FUSE/uninterruptible-sleep row. The behavioral mutation checks run the production stop routine with isolated processes and injected kernel observations. They reject numeric scan signals, missing parent/liveness checks, exhaustion without `ECHILD`, and missing deadline guards; syscall-traced PID reuse remains a separate required proof.

The source candidate still needs these fixture extensions: a deliberately wedged async runtime (E14), the complete double-fork/SIGCHLD-ignored-helper trace and PID-reuse experiment (E21), a per-close save-call counter (E16), and the read-only-filesystem publication arm (E2 currently injects a rename failure). Native E17/E20, Windows job membership and the Windows direct-`BrowserManager` e2e bootstrap also remain unverified. The current E5 pre-exec hook and E3 crash-before-rename hook exist only in test builds.

Windows now exposes `launch-group --stop` through its named-job routine; Unix continues to refuse external stop. Native Windows execution and Miri checking remain separate evidence requirements. Also, the upstream copied-profile-name failure path still removes its temporary copy after a failed launch; S2 must continue supplying its explicit owned profile path, and alias-profile failure cleanup needs an ownership-aware follow-up before that path is used for windows.

The follow-up fixes macOS PID-count sizing and zero-error handling, derives Windows list entries from the full allocation, routes maintenance stops through ownership checks, and retains poisoned ownership without panicking in teardown. The TS relay uses launch-bound close and the Unix stop channel or Windows named job; it never escalates to numeric PID signals. Legacy engines without ownership records are observed for their idle exit. Portable platform-contract fixtures exercise macOS enumeration and Windows decoding/fallback on Linux; they are not native OS results.
