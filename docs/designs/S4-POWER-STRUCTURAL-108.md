# S4 power: one block on each system

Revision: 4.1, 2026-10-26, final narrow revision (MurageMain go); 4.1 keeps Codex's own sandbox on Linux and macOS

An engine turn may run. It may not make the power calls named below. Each system gets one mechanism, the smallest one that system can apply without taking the engine's files, loopback, or credentials away. If that mechanism cannot be applied on a turn this phase does wrap, the turn does not start. This phase adds no command list and no card, so a word in an ordinary command is not a hold.

Full access keeps running on Linux, Mac, and Windows. No platform is held. The Mac block is a default-allow Seatbelt profile, and the Linux block is a user and pid namespace with the bus sockets covered and a minimal `/dev`. Each is applied only where it nests with that engine's own sandbox (section 2). The Windows block removes two privileges from the server's primary token. A wrapped turn starts when that cover is in place, and does not start when the cover cannot be built. That is the same shape as an engine Windows already refuses when its job cannot be created (`server/procs.ts:139-148`), not a hold of one platform. A Claude, Codex, or Fuigo turn that section 2 does not wrap still starts, Full access included.

## 1. What is already true

Full access returns before the destructive-command guard (`server/auto-approve.ts:938-943`). That guard names `shutdown`, `reboot`, and `halt` only (`server/auto-approve.ts:50`). There is no `host-power` rule in this tree. `protectedClass` treats the folder `/proc` as a system folder (`server/always-ask.ts:106-108`); anything deeper is ordinary (`server/always-ask.ts:156-157`).

`isDeviceWrite` matches a Windows physical drive, a whole Windows volume, and any `/dev/` name outside `DEVICE_STREAMS` (`server/shell/walk.ts:461-467`, the drive and volume tests at `walk.ts:463`). It is not `/dev/` only.

`fullAccessTurnOrigin` returns an origin string (`server/index.ts:18360-18366`). `fullAccessCovers` returns the boolean (`server/auto-approve.ts:361-364`): true for `owner` and `routine`, and for `owner-channel` only when `fullAccessChannelMessages` is exactly true. The stop line is dropped only when the origin is not `routine` and No limits covers the turn (`server/auto-approve.ts:876`). This phase does not read either function. The block is not a Full access flag.

Drivers do not receive a bot. `SendTurnInput` carries `stopLine` and `routeAsks` (`server/contracts.ts:516-531`). This phase does not add a field there.

`engineJob()` is undefined on Mac and Linux (`server/procs.ts:142-143`) and a named job on Windows. Turns already pass it: Claude (`server/drivers/claude.ts:4295`), Codex (`server/drivers/codex.ts:1115`), ACP (`server/drivers/acp/core.ts:3994`), Antigravity (`server/drivers/antigravity.ts:751`), Pi (`server/drivers/pi.ts:942`). Two engine spawns do not: Claude's review, proposal, and learning call (`server/drivers/claude.ts:5380`) and Antigravity's helper prompt (`server/drivers/antigravity.ts:1094`). Antigravity's helper passes `engineJob()` on every OS. Claude's review spawn follows section 2: the Windows job, and no `hostPower` on Mac or Linux, same as the turn spawn at `server/drivers/claude.ts:4295`.

On Windows the job is `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and nothing else (`native/engine-exclusion/exclusion.c:1856`), nested under libuv's job (`exclusion.c:1838-1841`). `server/memory/pip-job.ts:9-14` says Node cannot start a process suspended and that the CLI runs in the moment between spawn and assignment. That comment is stale for an engine launch. The launcher is assigned while it is blocked on its stdin (`server/procs.ts:292-313`) and starts the engine only after the frame (`server/job-launcher.ts:59-73`, the spawn at `job-launcher.ts:73`). The engine has not been created during assignment. There is still no suspended start. This phase does not change the job flags.

A cloud turn is already launched by `cloudTurnLaunch` (`server/cloud-home/turn-process.ts:107-123`, null unless `MURAGE_CLOUD_ROLE` is `home`). `spawnCli` uses that launcher instead of the engine (`server/procs.ts:240`). This phase does not wrap that launcher and does not edit `turn_mount_args`.

POSIX engines are started in a new session (`server/procs.ts:275-281`). There is no `host-power.ts`.

## 2. Where the block is applied

`engineJob()` returns `{ hostPower: true }` on Mac and Linux for a spawn section 2 wraps, and the existing `{ name }` on Windows (that object also sets `hostPower: true`). A Mac or Linux spawn this phase does not wrap does not set `hostPower`.

`spawnCli` applies the desktop block only when all of these hold:

- the 4th argument has `hostPower: true`
- `cloudTurnLaunch` returned null
- the call is not the docker server tool (`server/procs.ts:233-236`, the check at `server/procs.ts:240`)
- on Linux and macOS, the nesting rule below says this engine is wrapped

Everything else is unchanged, including version probes and catalog spawns that do not pass `engineJob()`:

- `server/drivers/pi.ts:484` and `server/drivers/pi.ts:1388`
- `server/drivers/acp/hermes.ts:720`
- `server/drivers/codex-catalog.ts:111`
- `server/mcp-probe.ts:122`
- `server/fuigo-native-update.ts:127`
- `server/drivers/headless-target-guard.ts:39`

The MCP probe passes the configured `server.command` and `server.args` (`server/mcp-probe.ts:103-126`). That argv is the owner's server, not a fixed Murage list. It still does not pass `engineJob()`, so the block is not applied. The other argv lists in this section are Murage's probes and catalog spawns. They are not a power block. See Not claimed.

The block is the same at Ask, Auto, Full access, and No limits, on the spawns it wraps. `fullAccessChannelMessages` is not an input.

Which engines, on each OS:

- **Windows, Claude, Codex, and Fuigo.** The block is the privilege removal on the server's primary token (section 6). It is not a mount namespace and not a Seatbelt profile. Every child inherits that token, so there is no per-engine exemption and no conflict with an engine's own filesystem sandbox. Codex keeps the sandbox mode `codexTurnPolicy` already returns (`server/drivers/codex-isolation.ts:139`). Fuigo keeps `--permission-mode` `bypassPermissions` under No limits and `default` otherwise (`server/drivers/acp/fuigo.ts:681-683`).
- **Linux and macOS, Codex.** The block is not applied. `codexTurnPolicy` stays unchanged: `read-only` for a proposal, `workspace-write` for an ordinary turn, and `danger-full-access` only for a non-proposal No limits (`fullAuto`) turn (`server/drivers/codex-isolation.ts:139`). Desktop sends that result from `policy()` (`server/drivers/codex.ts:1372`) on `thread/resume` (`server/drivers/codex.ts:2205`) and `thread/start` (`server/drivers/codex.ts:2248`), including the approval policy and the version's spelling (`server/drivers/codex-isolation.ts:143-145`). `workspace-write` and `read-only` keep Codex's own sandbox. On Linux that sandbox needs `mount` and the rest of the mount family section 4 denies. On macOS it applies Seatbelt, and a second Seatbelt under section 5's `sandbox-exec` does not apply. Codex's turn spawn (`server/drivers/codex.ts:1115`) does not set `hostPower` on these two systems. A resumed thread keeps the unchanged policy. The cloud branch at `server/drivers/codex.ts:2248` keeps the object built at `server/drivers/codex.ts:659-661`, because a cloud launch is not wrapped. The turn starts. Full access starts.
- **Linux and macOS, Claude.** The block is not applied. Murage does not send a sandbox mode it can retarget. `claudeIsolationSettings` has no sandbox key (`server/drivers/claude.ts:1407-1422`). The CLI does sandbox commands (`server/drivers/claude.ts:1909-1910`). A command sandbox that mounts does not run under section 4, and a command sandbox that applies Seatbelt does not nest under section 5. Claude's turn spawn (`server/drivers/claude.ts:4295`) and review spawn (`server/drivers/claude.ts:5380`) do not set `hostPower` on these two systems. The turn starts. Full access starts.
- **Linux and macOS, Fuigo.** The block is not applied. The desktop argv's `--permission-mode` is the approval mode (`server/drivers/acp/fuigo.ts:681-683`), not an OS sandbox, and this phase does not change it. The empty `sandbox.toml` the cloud launcher writes (`deploy/cloud-home/murage-turn-launch.py:3367`) sits inside the launcher this phase does not wrap. Fuigo has no sandbox mode Murage can retarget. The same two conflicts apply to a command sandbox on these systems, so Fuigo's spawn (`server/drivers/acp/core.ts:3994`, driver `fuigoAgent`) does not set `hostPower` on Linux or macOS. The turn starts. Full access, which is `bypassPermissions` on that flag, starts on every OS.
- **Every other spawn that passes `engineJob()`.** Pi, Antigravity, and the other engines stay wrapped on each OS, as revision 3. This revision's nesting limit is Claude, Codex, and Fuigo.

Nesting the block inside each engine's own sandbox (Claude, Codex, and Fuigo on Linux and macOS) is deferred to 1.0.9.

A required desktop launch that is refused before any process exists returns a child with no pid, in the shape of `unstartedLaunch` (`server/procs.ts:206-225`): `error` on the next tick (`server/procs.ts:197-201`), then exit and close with -2. The code on that error is `EPOWER`. `unstartedLaunch` today emits `ECONTAIN` (`server/procs.ts:216`, through `engineContainmentError` at `server/procs.ts:192-193`). This phase does not use `ECONTAIN` for the power block. `ECONTAIN` stays the job failure (`server/procs.ts:135-136`). The pid-less cases are: the helper is missing, not a regular file, or writable by this euid; `sandbox-exec` is missing; euid is 0; the session bus address is abstract; the bwrap argv would exceed 1 MiB; the Windows privilege is still present. No prompt is written. `notWritten` runs (`server/turn-attribution.ts:64-67`). Claude already calls it when a write will not happen (`server/drivers/claude.ts:4297-4298`). The attempt is not stamped as delivered.

`spawnCli` returns the real child synchronously once the wrapper has been spawned (`server/procs.ts:268-291`). That child has a pid. If the namespace is then refused, or `sandbox-exec` then rejects the profile, the child exits. That exit is not Node's spawn `error` and not the pid-less child. The sentence in section 8 is shown. `notWritten` runs when the engine has not accepted the turn, so bytes sitting in a pipe the wrapper never handed to an engine are not counted as delivered. A turn the engine has accepted is a running turn. A later exit is the engine's, not `EPOWER`.

A Windows launch whose privilege drop failed is `EPOWER` and does not reach job creation. A launch whose privilege drop worked and whose job then fails is still `ECONTAIN`.

## 3. Not claimed

These are outside the block. The failure table does not mark them closed.

- The owner's own menu, power button, and keyboard.
- A click, key, or type through the host-computer broker. `/api/internal/host-computer` calls `hostComputer.dispatch` (`server/index.ts:21913`). The broker's child proxies a separate host daemon (`server/host-computer-broker.ts:52-54`). That route stays. Full access computer use stays. The broker does not know a power control from any other pixel.
- Network clients, including SSH, a container socket, IPMI, Redfish, and Wake-on-LAN. This phase does not use pasta and does not claim a private network.
- A pathname socket other than the bus paths section 4 covers. A compositor socket, an X11 socket, `SSH_AUTH_SOCK`, and a docker or podman socket stay reachable on Linux. `connect` to a unix socket still works on a read-only mount (`deploy/cloud-home/murage-turn-launch.py:1325-1326`); this phase does not use a read-only home as a socket boundary.
- An abstract-namespace socket. If `DBUS_SESSION_BUS_ADDRESS` is abstract, a Linux turn this phase wraps does not start, because a mount cannot cover it and this phase does not add a network namespace.
- A unit file, autostart entry, crontab, or scheduled task the host loads on a later login or a later reload. This process tree cannot ask the manager to start it. The file on disk is not claimed.
- A Windows process that gets a new logon token: Task Scheduler, a service, WMI, or a process the WSL service starts.
- A Windows descendant that impersonates or substitutes an existing same-user token which still has `SeShutdownPrivilege` or `SeRemoteShutdownPrivilege`. Removing those privileges from the server's primary token does not stop that. No new logon is required. `InitiateSystemShutdownEx` checks the calling thread's token, so a thread that has taken such a token is outside this block.
- Windows log off: `ExitWindowsEx` with `EWX_LOGOFF`, `shutdown /l`, and `WTSLogoffSession`. Those do not require `SeShutdownPrivilege`.
- A Mac client that never looks up a denied Mach name, never opens a denied IOKit class, and never sends an Apple event to a denied destination. `launchctl` is in this set when it talks only to the inherited bootstrap port. Seatbelt `mach-lookup` filters `bootstrap_look_up` of the names in section 5. It does not take the bootstrap port away. `system.restart` and `system.shutdown` in the authorization database are the fast-user-switching checks (`/System/Library/Security/authorization.plist:1423-1428` and `:1518-1523`). Denying those rights is not this design.
- Signaling WindowServer, loginwindow, or another GUI process on the Mac. The profile allows signals. Denying every signal would break ordinary process control.
- Ending a Linux session through a compositor socket (`swaymsg`, `i3-msg`, and the same pattern).
- A `mount` call from a wrapped Linux process. The filter denies the mount family in section 4. It does not deny `unshare` or `clone`, and `no_new_privs` does not reject a user namespace. A new user namespace does not lift the filter, so `mount` stays denied. A program that needs a user namespace for something other than `mount` is not rejected by this filter. The Murage browser and the host-computer daemon are not inside this wrap.
- A later `mknod` of a device node. The filter does not list `mknod`. What this phase does claim is the `/dev` mounted at start (section 4): host disks and `/dev/mem` are not that mount.
- The spawns listed in section 2 that do not pass `engineJob()`, and a Claude, Codex, or Fuigo spawn on Linux or macOS that does not set `hostPower`.
- A cloud turn. Its launcher already has a boundary. This phase does not stack another one.
- A Linux server whose euid is 0, for a turn this phase wraps. The turn does not start. Cloud already refuses a uid map that is real root (`deploy/cloud-home/murage-turn-launch.py:1272-1281`). The desktop check is `geteuid() === 0` before spawn.

## 4. Linux

No pasta. No Landlock. No D-Bus policy language. No PID snapshot. No private root, so `/tmp`, the home directory, the credential file (`server/drivers/turn-credentials.ts:103-114`), Claude's MCP config (`server/drivers/claude.ts:3672`), and the broker socket (`server/procs.ts:943-952`, fallback at `server/drivers/claude.ts:636` and `:653`) stay where the code already puts them. Host loopback stays, so the agents mount and the memory mount keep `http://127.0.0.1` (`server/index.ts:1827`, `server/index.ts:3615`). Host DNS stays, because `/etc/resolv.conf` is the host file and this phase does not run pasta's `--dns-forward`.

The server, at startup, binds one unix socket in a `0700` directory and accepts only to close the connection. The same socket is used for every wrapped engine. If it cannot be bound, a wrapped engine turn does not start.

`spawnCli` runs the shipped `bwrap` with a fixed environment, `PATH` only, the same idea as the cloud launcher's environment (`server/procs.ts:274`) and the Windows launcher (`server/procs.ts:164-169`, applied at `server/procs.ts:285-287`). The turn's environment is not the bwrap process's environment. `spawnCli` today copies the caller's options into the spawn (`server/procs.ts:268-270`); the bwrap spawn does not. The turn environment is applied inside, with `--clearenv` and one `--setenv` per variable. If that argv would exceed 1 MiB, the turn does not start. There is no fallback that lets the turn environment reach bwrap.

bwrap is an absolute path next to the app, realpath'd, a regular file, not a symlink, and not writable by this euid. The directory that contains bwrap and the seccomp bpf is `--ro-bind` after the root bind, so a later write in the turn cannot replace the helper. If bwrap rejects `--clearenv` or `--uid`, the turn does not start.

Flags, in this order:

- `--unshare-user --uid <euid> --gid <egid> --unshare-pid --cap-drop ALL --die-with-parent --new-session`
- `--bind / /`
- `--dev /dev`
- `--proc /proc`
- `--ro-bind` of the helper directory onto itself
- `--bind` of the stub socket onto each path below that exists
- `--seccomp` on a bpf fd that is the only extra descriptor; stdio is the engine's three pipes and that fd
- `--chdir` to the requested cwd
- `--` then the engine and its argv, unchanged

No `--unshare-net`, no `--tmpfs /tmp`, no `--dev-bind`.

`--bind / /` remounts with nodev, so the host device nodes that come in on that bind do not open. `--dev /dev` is the next mount and covers `/dev`. It is a fresh tmpfs, not a bind of the host `/dev`. Bubblewrap creates `null`, `zero`, `full`, `random`, `urandom`, `tty`, a devpts at `pts`, `ptmx` linked to `pts/ptmx`, a tmpfs at `shm`, and `fd`, `stdin`, `stdout`, `stderr` linked through `/proc/self/fd` (which `--proc /proc` supplies). Shell redirection, git, and node open that set. `--dev-bind` is not passed, so host disks, `/dev/mem`, input nodes, and other control nodes are not the `/dev` the process sees. `--new-session` means there is no controlling terminal: the `tty` node is created, and opening it may still fail. Redirection uses `/dev/null`, which does open.

The stub covers, when the path exists:

- `/run/dbus/system_bus_socket`
- `/var/run/dbus/system_bus_socket` when it is not the same file
- `/run/systemd/private`
- `$XDG_RUNTIME_DIR/bus`
- `$XDG_RUNTIME_DIR/systemd/private`
- the pathname in `DBUS_SESSION_BUS_ADDRESS` when that address is `unix:path=...`

Inside the namespace those paths are the stub inode, not the host bus. `umount2` is denied by seccomp, so the process cannot lift the cover. A method call cannot be made on a socket that closes. This is the whole D-Bus claim. There is no allowlist of member names, because nothing on these sockets is forwarded.

`systemctl`, `loginctl`, and `busctl` fail, including `systemctl status` and `systemctl --user`. That is the bus being closed, not a card. Compiles, tests, git, and file edits do not open these sockets.

The seccomp filter is a new small bpf, not the cloud list. The cloud list also denies `unshare`, `ptrace`, and `io_uring` (`deploy/cloud-home/murage-seccomp.c:27-33`). This phase does not claim those and does not ship that bpf. The small filter denies only:

`reboot`, `kexec_load`, `kexec_file_load`, `mount`, `umount2`, `pivot_root`, `move_mount`, `mount_setattr`, `open_tree`, `fsopen`, `fsmount`, `fsconfig`, `fspick`

A name that does not resolve is a build failure, as the cloud generator already requires (`murage-seccomp.c:35-47`). x86_64 and aarch64 only (`murage-seccomp.c:15-20`). Any other architecture: a wrapped turn does not start. bwrap's seccomp sets `no_new_privs`. Setuid and file capabilities do not raise privilege. `sudo`, `doas`, `pkexec`, and `su` do not become root. `no_new_privs` does not reject `unshare` or `clone`.

1.0.8 pins the small power filter for both Linux x64 and arm64 in `native/power-seccomp/POWER-BPF-HASHES.txt` and `server/host-power.ts`. The native aarch64 gate on the build host cax11 Ubuntu 24.04 (2026-10-26, libseccomp 2.5.5, cc 13.3.0) generated identical bytes twice from the unchanged source. All 13 deny-list names resolve to native syscall numbers, or that generator exits before exporting the filter. The list relies on no x86-only syscall: aarch64 uses `umount2` and has no separate `umount` syscall. No additional aarch64 name is needed for the listed capabilities; other ABIs are rejected by the filter. Cage resources are selected by `linux-${arch}`; this does not add an arm64 desktop installer.

The pid namespace has no host pids. `kill` of a host pid, a negative host process group, a host pidfd, or a queued signal to a host task has no such target. This replaces a PID snapshot. It is not a snapshot.

`--proc /proc` is the namespace procfs. Writing `/proc/sysrq-trigger` needs a capability `--cap-drop ALL` removed, and `reboot` is denied by the filter. Neither the server nor a test writes a byte to that file.

AppArmor on Ubuntu needs `userns` on the bwrap binary. The packaged profile grants that to `/opt/Murage/murage` (`build/linux-apparmor-profile.tpl:12-17`) and to the bundled browser (`build/linux-apparmor-profile.tpl:19-20`). Add the same `flags=(unconfined)` and `userns` profile for the shipped bwrap path. If the kernel refuses the user namespace, a wrapped turn does not start. No environment variable skips the wrap.

What this makes unreachable from the wrapped process:

- `reboot(2)`, `kexec_load`, `kexec_file_load`
- a D-Bus method to logind or to systemd, system or user, including `PowerOff`, `Reboot`, `Suspend`, `Hibernate`, `HybridSleep`, `SuspendThenHibernate`, `ScheduleShutdown`, session `Terminate` and `Kill`, and `StartUnit` in every mode
- a host pid

## 5. macOS

The tree already has Seatbelt launches. The Fuigo probe writes `(allow default)` and `(deny network-outbound)` and runs `/usr/bin/sandbox-exec` (`server/fuigo-probe-isolation.ts:35-40`). That profile is a network deny for one probe. It is not this block. Generated-code runs use `/usr/bin/sandbox-exec` with `-p` and an inline profile (`src/e2e/b10-generated-code-sandbox.ts:31` and `:133`). This phase uses that invocation, not a profile file on disk. The probe spawn (`server/fuigo-native-update.ts:127`) does not pass `engineJob()` and is not wrapped.

`spawnCli` runs, for a spawn section 2 wraps:

`/usr/bin/sandbox-exec -p <profile> <engine> <args>`

The engine's stdio, cwd, and environment are the spawn's. The profile text is fixed in the server. It contains no path and no turn string.

```
(version 1)
(allow default)
(deny mach-lookup
  (global-name "com.apple.logind")
  (global-name "com.apple.PowerManagement.control")
  (global-name "com.apple.iokit.powerdxpc"))
(deny iokit-open-service
  (iokit-registry-entry-class "IOPMrootDomain"))
(deny iokit-open-user-client
  (iokit-user-client-class "RootDomainUserClient"))
(deny appleevent-send
  (appleevent-destination "com.apple.loginwindow")
  (appleevent-destination "com.apple.systemevents")
  (appleevent-destination "com.apple.finder"))
```

The Mach names and the IOKit classes are the power-assertion set the system profile grants to apps (`/System/Library/Sandbox/Profiles/appsandbox-common.sb:663-670`), plus `com.apple.logind`, which `application.sb` looks up beside that set (`/System/Library/Sandbox/Profiles/application.sb:728` and `:734`). The Apple event filter is the form already used for Finder (`/System/Library/Sandbox/Profiles/com.apple.StorageManagement.Service.sb:95`), here as a deny, for the three destinations a shutdown script targets.

`(allow default)` keeps files, exec, and the network, including loopback. Apple events to Finder, System Events, and loginwindow fail, including events that are not power. `open` and ordinary shell commands are not those events. There is no card and no replay. A denied lookup is denied.

Claude, Codex, and Fuigo are not placed in this profile. Codex keeps the sandbox mode `codexTurnPolicy` returns (section 2).

If `/usr/bin/sandbox-exec` is missing, a wrapped turn does not start (no pid, `EPOWER`). If `sandbox-exec` starts and then rejects the profile, the child has a pid and exits, and section 2's prompt rule applies. Children of a process that is under the profile stay under it. The Murage process is not sandboxed, so the owner's own UI is not under this profile.

`/usr/bin/true` exiting 0 is not the compatibility proof. The qualification is that, plus a shell redirection and `node -e` writing a byte, both under the same profile and both exiting 0, and a helper under the same profile whose `bootstrap_look_up` of `com.apple.logind` is denied. The helper does not call `shutdown`, `pmset`, or an Apple event that would power the machine. A retained process is reused only when its warm key matches, including `hostPower` when the spawn is wrapped (section 7). Stop stays the path the driver already has.

## 6. Windows

Do not set `JOB_OBJECT_UILIMIT_EXITWINDOWS`. A job with a UI limit is not an ordinary nested job, and this process is already nested under libuv (`native/engine-exclusion/exclusion.c:1838-1841`). The job flags stay `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` only (`exclusion.c:1856`). PIP is unchanged. `CreateProcessAsUser` is not used: a normal user token does not have the privilege that call needs.

At load of `server/procs.ts`, on `win32`, the addon removes `SeShutdownPrivilege` and `SeRemoteShutdownPrivilege` from the server's own primary token with `AdjustTokenPrivileges` and `SE_PRIVILEGE_REMOVED`. Removal is not a disable. That token cannot have the privilege added back. A token that already lacks both is success. After the call, `TokenPrivileges` on that primary token must not contain either LUID. If the addon is missing or either LUID remains, the drop failed.

The Windows launcher spawns the engine with Node `spawn` (`server/job-launcher.ts:73`), which inherits the primary token. Every child of the server inherits it, including a launcher that was started without a job, and including Claude and Fuigo. A standard user does not need an extra privilege for this, because the token is the process's own.

What this enforces: a thread whose token is that inherited primary token cannot enable either privilege. With that token, `ExitWindowsEx` for shut down, restart, and power off fails the privilege check, and so do `InitiateSystemShutdownEx`, `SetSuspendState`, and the other documented suspend and hibernate calls that require `SeShutdownPrivilege`. `shutdown.exe` as a child inherits the stripped primary token and cannot enable the privilege on that token.

What this does not enforce is in section 3: a descendant that impersonates or substitutes an existing same-user token which still has either privilege. Log off is Not claimed.

The drop runs once, before any engine spawn. A retained process started after a successful drop inherits the stripped token. Job assignment and Stop stay as they are.

## 7. Reuse

The block is not per turn, so a change to `fullAccessChannelMessages` cannot change it.

Claude's warm key is the object at `server/drivers/claude.ts:3835-3860`. A matching key reuses the process and does not spawn (`server/drivers/claude.ts:3918-3926`). Codex builds the same kind of key at `server/drivers/codex.ts:954-974`. ACP puts the spawn contract in the digest at `server/drivers/acp/core.ts:3972-3975`. `warmKey` hashes every field (`server/drivers/warm-key.ts:34-37`), and `diffWarmKey` returns the first field that differs (`server/drivers/warm-key.ts:49-56`).

Add `hostPower: 1` to a key whose spawn is under the block. Claude, Codex, and Fuigo on Linux and macOS are not under the block, so their keys do not carry the field. Claude, Codex, Fuigo, and the other wrapped engines carry it on Windows. A key recorded without the field does not match a key recorded with it, so a process from a build that did not wrap is not reused as a wrapped one. The value is a constant. It is not the bot, the origin, the channel flag, or the Codex sandbox mode. The sandbox mode is sent on `thread/start` and `thread/resume`. A reused Codex process retains its thread's sandbox (`turn/start` sends only `approvalPolicy`, `server/drivers/codex.ts:2404`); `thread/start` and `thread/resume` send the unchanged `codexTurnPolicy` sandbox string.

Claude learning does not go through `hiddenTurnRunner`. `MemorySessionRunner` takes a prompt and a signal (`server/drivers/cli-memory-learning.ts:47`). The default runner sends a turn (`server/drivers/cli-memory-learning.ts:128-152`), which reaches a driver that already passes `engineJob()`. Claude replaces that runner (`server/drivers/claude.ts:5345-5350`) and spawns at `server/drivers/claude.ts:5380`, wired at `server/drivers/claude.ts:5591`. Editing `cli-memory-learning.ts:152` does not wrap the Claude spawn. Passing the Windows job at `claude.ts:5380` does, and that spawn does not set `hostPower` on Mac or Linux. Antigravity's helper prompt at `server/drivers/antigravity.ts:1094` passes `engineJob()` on every OS.

## 8. What the user sees

No card. No new button. No new inbox label. A wrapped turn that runs a power command sees that command fail. Murage does not add a card for it. An unwrapped Claude, Codex, or Fuigo turn on Linux or macOS is unchanged.

One message, used only when a wrapped turn was not started because the block could not be applied, whether that was the pid-less refusal or the wrapper's exit before the engine accepted the turn. No em dash. The message passes the copy scan (`src/copy-rules.test.ts:381-384`), whose patterns are at `src/copy-rules.test.ts:29-40`. It does not say log off. Windows log off is Not claimed.

The owner sentence must give a next step in plain words, one that is true for every refusal cause on that system.

Linux and macOS: `Murage could not block shut down and restart for this engine, so this turn was not started. You can choose Claude, Codex or Fuigo as this bot's engine now, or update or reinstall Murage and try again.`

Windows: `Murage could not block shut down and restart for this engine, so this turn was not started. Update or reinstall Murage, then try again.`

## 9. Failure table

`blocked` means the wrapped process cannot complete that call with the token or the namespace it started with. `refused` means the turn was not started. Anything section 3 names is not in this table.

| Call | Linux | macOS | Windows |
|---|---|---|---|
| `reboot(2)`, `kexec_load`, `kexec_file_load` | blocked, seccomp `EPERM` | not this profile | not the inherited token |
| logind or systemd method, including power, sleep, session kill, and `StartUnit` | blocked, stub socket | `com.apple.logind` lookup denied | not the inherited token |
| `IOPMrootDomain`, `RootDomainUserClient`, `com.apple.PowerManagement.control`, `com.apple.iokit.powerdxpc` |  | blocked |  |
| Apple event to loginwindow, System Events, or Finder |  | blocked |  |
| Shut down, restart, suspend, hibernate, when the thread token is the inherited primary token |  |  | blocked, privilege absent on that token |
| Signal to a host pid | blocked, pid namespace | Not claimed | Not claimed |
| `sudo`, `doas`, `pkexec`, `su` | blocked, no new privilege on exec | not this profile | not the inherited token |
| Helper missing, `sandbox-exec` missing, euid 0, abstract session bus, argv over 1 MiB, privilege still present | refused, no pid, `EPOWER` | refused, no pid, `EPOWER`, when `sandbox-exec` is missing | refused, no pid, `EPOWER`, when the privilege remains |
| Wrapper spawned, then namespace or profile rejected | exits with a pid; sentence; prompt not delivered | same | not this wrapper |
| Claude, Codex, or Fuigo turn | not wrapped; turn starts | not wrapped; turn starts | inherited token, as every child |

## 10. Tests

No test powers a machine. No test calls `ExitWindowsEx`, `SetSuspendState`, `pmset sleepnow`, an Apple event that shuts down, or `reboot` with a real magic on the host. Linux bus tests connect to the stub and expect the connection to fail. They do not connect to the host bus.

- Mac and Linux: a Pi spawn with `hostPower: true` and no cloud launch uses the wrap. A Claude spawn, a Codex spawn, and a Fuigo spawn do not set `hostPower` and are not wrapped. A spawn without the marker does not use the wrap. A cloud launch is not wrapped. The docker server tool is not wrapped. On Windows the privilege drop is process-wide; Claude, Codex, and Fuigo are not exempt.
- The engine argv is unchanged after the profile or after bwrap `--`. `echo reboot` is not rewritten and raises no card. This phase does not edit `auto-approve.ts`.
- Missing `sandbox-exec`, missing bwrap, a writable bwrap, an abstract session address, and euid 0 return no pid, `EPOWER`, and the sentence, and `notWritten` has run. A bwrap or `sandbox-exec` that starts and is then rejected has a pid, exits, shows the sentence, and does not count the prompt as delivered. It is not the `ECONTAIN` child.
- bwrap argv has the flags in section 4, in that order, including `--dev /dev` and `--clearenv`, and has no `--unshare-net` and no `--dev-bind`. The bwrap spawn environment is `PATH` only.
- The seccomp source denies the syscalls in section 4 and does not list `unshare`, `ptrace`, `io_uring`, `clone`, or `mknod`.
- A fixture under bwrap can read a file in its cwd, connect to `127.0.0.1` on the host, and resolve a name through the host resolver. A connect to `/run/dbus/system_bus_socket` inside the namespace fails.
- The same fixture, still under the section 4 argv, exits 0 for a shell redirection (`echo ok >/dev/null`), `git status` in a repository the fixture initialized, and `node -e` writing one byte to stdout. `null`, `zero`, `full`, `random`, `urandom`, `tty`, `ptmx`, and `pts` are present. `/dev/mem` is not opened as a device. The fixture does not write `/proc/sysrq-trigger` and does not call `reboot`. It skips when the platform is not linux or bwrap cannot build the namespace.
- macOS: `sandbox-exec -p` of the profile runs `/usr/bin/true`, a shell redirection, and `node -e` writing a byte, each to exit 0. The lookup helper is denied `com.apple.logind`. None of them calls `shutdown`, `pmset`, or a power Apple event. They skip when the platform is not darwin.
- Codex mode: on linux and darwin, a non-cloud turn is not wrapped and sends the unchanged `codexTurnPolicy` sandbox string on `thread/start` and `thread/resume`: `read-only` for a proposal, `workspace-write` for an ordinary turn, and `danger-full-access` only for a non-proposal `fullAuto` turn (`server/drivers/codex-isolation.ts:139`). Check the installed version's spelling, including `readOnly`, `workspaceWrite`, and `dangerFullAccess` below `CODEX_KEBAB_POLICY_MIN` (`server/drivers/codex-isolation.ts:143-145`). The approval string is the one `codexTurnPolicy` returns for that version and those flags. On win32 the sandbox string stays `read-only`, `workspace-write`, or `danger-full-access` as `codexTurnPolicy` returns it today. A non-proposal `fullAuto` turn is `danger-full-access` on every OS and is not refused for nesting; a proposal stays `read-only` even with `fullAuto`. The cloud object at `server/drivers/codex.ts:661` is unchanged.
- Windows: a token fixture that still contains either privilege on the primary token is a failed drop. A fixture that lacks both is success. The test does not treat a second same-user token as covered. The job limit flags in `exclusion.c` are unchanged. The test does not create a UI-limited job.
- `diffWarmKey` on a wrapped Claude or Codex key compared with the same key without `hostPower` returns `hostPower`. Claude and Codex keys for linux or darwin spawns have no `hostPower` field. The ACP digest changes when the constant is included on a wrapped spawn, and does not include it for Fuigo on linux or darwin. The wrap decision does not read `fullAccessChannelMessages`.
- `claude.ts:5380` passes `engineJob()` on Windows and does not set `hostPower` on Mac or Linux. `antigravity.ts:1094` passes `engineJob()` on every OS.
- The sentence matches `src/copy-rules.test.ts:29-40` and does not name log off.
- Stop of a wrapped process is the path the driver already uses (the Windows job, or the POSIX session). This phase does not add a Stop implementation.

## 11. Review responses

Astra r2. Each item is accepted, cut, or rejected.

1. **High, pasta `-T` (sections 4, 9, 11 of r2). Cut.** Omitting `-T` leaves pasta's automatic host TCP forward, and `--no-map-gw` does not replace it. Cloud passes `-T` with one port (`deploy/cloud-home/murage-turn-launch.py:1168-1169`), not `-T none`. This phase does not run pasta and does not claim loopback isolation. Host loopback is required by the agents and memory mounts (`server/index.ts:1827`, `server/index.ts:3615`).

2. **High, read-only mounts and pathname sockets (sections 4, 6, 11). Cut.** A read-only mount still allows `connect` (`deploy/cloud-home/murage-turn-launch.py:1325-1326`). This phase does not bind the home read-only and does not claim those sockets. The only sockets it claims are the bus paths in section 4, replaced by the stub inode. Every other pathname socket is Not claimed.

3. **High, Claude reuse (sections 7, 13). Accepted.** The warm key at `server/drivers/claude.ts:3835-3860` has no block field, and a match skips spawn (`server/drivers/claude.ts:3918-3926`). r2's per-turn flag would have changed coverage when `fullAccessChannelMessages` changed and left the key stale. There is no per-turn flag. `hostPower: 1` is a constant on a key whose spawn is wrapped: Claude, Codex, and Fuigo on Windows only, and the other wrapped engines on every OS. `diffWarmKey` reports the missing field (`server/drivers/warm-key.ts:49-56`).

4. **High, the launcher can be edited from the turn (sections 4, 8, 13). Accepted.** `spawnCli` forwards the caller's options (`server/procs.ts:268-270`). The Windows launcher already uses a fixed environment (`server/procs.ts:164-169`, `server/procs.ts:285-287`). bwrap is spawned the same way: absolute shipped path, `PATH` only, `--clearenv` before the turn's `--setenv`, helper directory remounted read-only, turn refused when the helper is writable by this user. There is no starter script in the project.

5. **High, the handshake directory is not visible in the sandbox (sections 4, 8). Cut.** r2 put the report directory on the host tmpfs and then replaced `/tmp` inside bwrap, so the gate could not be released. This phase has no gate, no report file, and no release file. bwrap execs the engine. A bwrap that never starts is the pid-less child. A bwrap that starts and is then rejected is that process's exit (section 2).

6. **High, the broker directory is not private (section 4). Cut.** The socket is under `DATA_DIR`, or in the temp directory when the path is too long (`server/procs.ts:943-952`, `server/drivers/claude.ts:636` and `:653`). This phase does not bind a broker directory. `--bind / /` leaves the socket where that code put it.

7. **High, a private `/tmp` and a blocked loopback break the engine (sections 4, 7, 12). Cut.** Claude's MCP config is under the host temp directory (`server/drivers/claude.ts:3672`). Credentials are too (`server/drivers/turn-credentials.ts:103-114`). Agents and memory use host loopback (`server/index.ts:1827`, `server/index.ts:3615`). This phase does not hide `/tmp` and does not take the host network. No relay is added. The bus stub is the power block, not a network block.

8. **Medium, DNS (sections 4, 12). Cut.** Binding the host `/etc` keeps a stub resolver, and pasta's `--dns-forward` does not rewrite it. Cloud mounts a generated resolv.conf (`deploy/cloud-home/murage-turn-launch.py:4653-4658`). This phase does not use pasta. The host `/etc/resolv.conf` stays on the root bind, and the host network can reach the resolver it names.

9. **High, background inference (sections 1, 7, 13). Accepted.** `MemorySessionRunner` has no bot (`server/drivers/cli-memory-learning.ts:47`). Claude does not use the runner at `cli-memory-learning.ts:152`; it installs its own (`server/drivers/claude.ts:5345-5350`) and spawns at `server/drivers/claude.ts:5380` (`:5591`). The fix is the Windows job on that spawn, no `hostPower` on Mac or Linux, and `engineJob()` on `server/drivers/antigravity.ts:1094`. No authority field is added to `SendTurnInput`.

10. **Medium, delegation paths (sections 4, 11). Cut.** `~/.config/systemd` is not the whole set; `~/.local/share/systemd/user`, `XDG_CONFIG_HOME`, and `/etc/xdg/autostart` are real load paths. This phase does not claim those directories are read-only. It claims this process cannot talk to the manager, because those sockets are the stub, so it cannot start a unit it wrote. A later login that loads the file is Not claimed.

False code claims in r2, all accepted and corrected in section 1:

- `isDeviceWrite` is not `/dev/` only. Windows physical drives and volumes are matched at `server/shell/walk.ts:463`.
- A Seatbelt profile generator is in the tree at `server/fuigo-probe-isolation.ts:35-40`. It denies outbound network for the Fuigo probe. It is not the power profile.
- `server/memory/pip-job.ts:9-14` says there is no suspended start. That comment describes a direct CLI spawn. An engine launch waits in the launcher (`server/procs.ts:292-313`, `server/job-launcher.ts:59-73`) and does not run the engine in that window.
- `fullAccessTurnOrigin` returns origin strings (`server/index.ts:18360-18366`). The booleans are `fullAccessCovers` (`server/auto-approve.ts:361-364`).

## 12. Revision 4 responses

Astra r3. Each item is accepted. Citations below were checked against this tree.

1. **High, Windows token substitution (sections 3, 6, 9). Accepted.** Removing `SeShutdownPrivilege` and `SeRemoteShutdownPrivilege` from the server's primary token constrains threads that use that inherited token. It does not stop a descendant from opening an existing same-user token that still has them and impersonating it. No new logon is required, and `InitiateSystemShutdownEx` uses the calling thread's token. Section 3 states that plainly under Not claimed. Section 6 states what the inherited token does enforce. The failure table's Windows cell is limited to that token. Log off stays Not claimed.

2. **High, ordinary Linux devices (section 4). Accepted.** `--bind / /` is nodev, so forbidding both `--dev` and `--dev-bind` made `/dev/null` and `/dev/urandom` fail. The argv now has `--dev /dev` after `--bind / /` and before `--proc /proc`, and still has no `--dev-bind`. That mount is the minimal set: `null`, `zero`, `full`, `random`, `urandom`, `tty`, `pts`, `ptmx`, `shm`, and the fd links. Host disks and `/dev/mem` are not mounted. Section 10 tests a shell redirection, `git status`, and `node -e` under that argv, and checks the nodes.

3. **High, nesting with the engines' own sandboxes (sections 4, 5, 10). Accepted.** The block is applied only where it nests. Windows applies the inherited token to Claude, Codex, and Fuigo. On Linux and macOS, Claude, Codex, and Fuigo are not wrapped, and their turns still start. Codex keeps the sandbox string returned by `codexTurnPolicy` (`server/drivers/codex-isolation.ts:139`, version spelling at `:143-145`), sent at `server/drivers/codex.ts:2205` and `:2248`: `workspace-write` for an ordinary turn, `read-only` for a proposal, and `danger-full-access` only for a non-proposal No limits (`fullAuto`) turn. The approval policy is unchanged. The gate and the card stay. Full access starts on every OS. `/usr/bin/true` is not the proof. Section 10 adds the ordinary commands, the Codex mode check, the warm-key rule for retained processes, and the existing Stop path.

4. **Medium, wrapper-failure reporting (sections 2, 8, 10, 11.5). Accepted.** A bwrap or `sandbox-exec` that `spawnCli` starts has a pid (`server/procs.ts:268-291`). A later namespace or profile rejection is that child's exit, not Node's spawn `error`, and not `unstartedLaunch`. Pid-less `EPOWER` is only the refusal before spawn. `unstartedLaunch` today emits `ECONTAIN` (`server/procs.ts:206-225`); the power refusal uses `EPOWER` and leaves `ECONTAIN` for the job. `notWritten` (`server/turn-attribution.ts:64-67`) runs when the engine has not accepted the turn, so the prompt is not stamped as delivered. Section 8's sentence no longer says log off. Windows log off stays Not claimed.

5. **Low, remaining facts (sections 1, 2, 3). Accepted.** The MCP probe receives `server.command` and `server.args` (`server/mcp-probe.ts:103-126`), not a fixed Murage argv. `server/memory/pip-job.ts:9-14` is not the engine assignment window; the launcher waits (`server/procs.ts:292-313`, `server/job-launcher.ts:59-73`). The filter and `no_new_privs` do not reject user namespaces. Section 3 now says the filter denies `mount` and does not deny `unshare` or `clone`.

6. **Revision 4.1.** MurageMain approved keeping Codex outside the block on Linux and macOS, alongside Claude and Fuigo, so Codex keeps its own workspace-write confinement for ordinary turns and read-only confinement for proposals. The unchanged `codexTurnPolicy` supplies the sandbox and approval strings; only a non-proposal No limits (`fullAuto`) turn uses `danger-full-access`. Codex has no `hostPower` spawn marker or key field on these two systems and is listed under Not claimed. Section 10 checks the unchanged strings and absence of wrapping and key field. Windows still covers every engine. Nesting the block inside each engine's own sandbox for Claude, Codex, and Fuigo on Linux and macOS is deferred to 1.0.9.
