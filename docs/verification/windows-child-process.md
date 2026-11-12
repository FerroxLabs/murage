# Windows background child processes

The first root import installs `shared/win-hide-child-process.mjs`. On Windows,
async APIs use `ChildProcess.prototype.spawn` after Node normalizes arguments.
Sync API decorators forward untouched arguments to Node and temporarily decorate
`process.binding('spawn_sync').spawn`, restoring it in `finally`. No production
native call is stubbed, and no overload positions are inferred. This private
binding boundary is qualified against Node 24.11.0 and the pinned Electron
43.8.1; upgrades must repeat the differential tests.

There are no approved `windowsHide:false` sites. The normalized boundary always
sets true: Node itself turns an omitted flag into false, so the normalized
boolean cannot authorize an opt-out. A future exception needs a reviewed site
and an explicit authorization mechanism. Linux and macOS return before touching
APIs, environment, argv, or caller options.

The self-contained `--import=data:` preload is inherited through both
`process.execArgv` and `NODE_OPTIONS`. Node Workers default to a native snapshot
of startup argv; mutating the JavaScript array alone does not reach that
snapshot. A Worker constructor adapter supplies the current inherited argv
explicitly, including for eval Workers. No descendant target is resolved.
Every explicit env/execArgv override must call `withHideInherit(...)` directly
at its launch; the helper returns the exact original object on non-Windows.

`check-windows-hide-entries.mjs` checks root import order and explicit launch
inheritance. Package main/bin, builder main, server bundles, the proxy registry,
and packaged script roots are entries. Worker/fork targets and their assignments
are deliberately not followed. Nonliteral launch options and option spreads
fail unless directly wrapped. `check-windows-hide.mjs` also bans unreviewed
false flags and audits embedded eval source. These checks do not purport to
perform general inter-module analysis of third-party code.

Bundler banners install before external dependencies. Pi extensions carry a
relocated shared installer; Electron ships it in the asar, and the standalone
installer archive includes it. Sentinel remains self-contained.

Run in the job's isolated test container:

```sh
node --test shared/win-hide-*.node-test.mjs scripts/windows-hide-posix.node-test.mjs
pnpm exec vitest run scripts/check-windows-hide.test.mjs scripts/check-windows-hide-entries.test.mjs scripts/win-hide-bundles.test.mjs
node scripts/check-windows-hide-entries.mjs
pnpm build:server
pnpm build:companion
```

The generated suite runs 8 × 8 × 8 argument-kind products for each of seven
Node APIs plus promisified exec/execFile, on win32, Linux and macOS (13,824
comparisons). Real Node functions execute up to test-only native-boundary stubs;
accepted options and rejection codes are compared. Five mutation tests must
fail: missing prototype hook, function-slot bypass, missing execArgv inheritance,
missing NODE_OPTIONS inheritance, and a bare env literal. Real descendant tests
exercise Worker, fork, spawn and execFileSync with default and replaced options.
They cannot establish real desktop console visibility.

The executable desktop gate is `scripts/windows-hide-desktop-gate.ps1`.
Its invocation and exact success-output contract are in
[the desktop gate instructions](windows-hide-desktop-gate.md). MAIN runs it in
`C:\murage-ci`; Linux results do not replace this gate.

Windows acceptance belongs to MAIN. On the reported Windows PCs, use disposable
standard-user accounts and fixture data, including a profile path with spaces.
Record OS build, default terminal application, installer/executable SHA-256,
app version and the tested commit. Compare 1.0.18 with the 1.0.19 candidate:

1. Launch from Start/the desktop; record the screen through startup, idle,
   minimization, quit and relaunch. Repeat with Windows Terminal and Console Host.
2. Verify the packaged executable is PE GUI subsystem 2. Verify Sentinel's task
   invokes it directly with `--murage-sentinel-scan`, the staged scanner and
   `--once`, with no cmd/PowerShell wrapper.
3. Run the fixture installation's Sentinel task three times, then leave it idle
   for ten minutes, both with Murage open and closed. Require advancing run times,
   successful exit status, no console/tab/taskbar flash, and no focus theft.
4. With a console-subsystem Node.exe, exercise a harmless local stdio MCP echo
   fixture repeatedly. Check stdin/stdout responses, stderr separation, failure
   and cancellation. Exercise the Codex conflicting-environment launcher's direct
   branch and Windows ENOENT shell fallback with harmless fixture commands.
5. Exercise fixture companion startup/restart, a memory worker, engine-history
   and transcript workers, and app shutdown. Use fake/local engines only; no
   credentials, paid providers or customer data. Record expected results and any
   flash with time and process identity. Keep the observer terminal minimized.
6. Attach recordings, scheduler XML/run results, hashes and fixture transcripts.
   Linux unit/container success does not replace this Windows desktop evidence.

Electron launches outside `node:child_process`:

- `electron/main.mjs` starts the server and recovery worker with
  `utilityProcess.fork`; `electron/companion.mjs` starts the companion the same
  way. These use Electron's GUI-subsystem executable, not a console Node.exe or
  shell helper. The server, recovery worker and companion each install the
  child-process default on entry for their own descendants. Both server and recovery are explicitly registered roots.
- `shell.openPath` in `electron/main.mjs` opens diagnostics folders/logs,
  exported diagnostics, saved files, and workspace files. The updater's vendored
  bundle uses it for the installer handoff. These are intentional OS file/app
  openings, with no cmd/PowerShell helper. They do not support `windowsHide` and
  are **not hidden** by the Node decorator; the chosen application or installer
  is meant to be visible. Desktop acceptance must distinguish that UI from a
  background console flash.
- Native backup-age, browser-extension and fuigo-probe child creation uses
  `CREATE_NO_WINDOW`. Recovery's ordinary helper uses `CREATE_NO_WINDOW`; its
  elevated ShellExecuteEx handoff specifies `SW_HIDE` (the OS consent dialog
  remains user-visible). These flags bypass the Node decorator and must also
  be checked in Windows desktop acceptance.
