# Exec-time wipe shim

Owner: wg-shim owns this directory and its container fixtures. wg-callback owns
`../client.mjs`, `../server.ts` and guard-file creation. wg-wiring owns PATH,
turn lifecycle and packaging.

Keep `guard.sh`, `guard-lib.sh` and `guard-request.sh` together. Tool names are executable regular byte copies of
`guard.sh`; argv[0]'s basename selects the tool. Keep those copies in sync when changing `guard.sh`. The private installer adds a regular copy for
each additional `mkfs.<filesystem>` found on the original PATH. Resolve real
executables before prepending this directory and record their absolute paths in
`realTools`. Otherwise the shim searches PATH past every alias of its directory.

The guard file is the JSON schema in the binding hybrid design addendum. The
compact `JSON.stringify` representation has a fast built-in-only reader;
alternative formatting uses the full POSIX sh JSON parser. Roots are canonical
per the producer contract. Path operands resolve existing directory symlinks
physically, including symlinks before `..`; missing tails normalize lexically.
Windows drive spellings normalize to Git Bash `/c/...` form. No argument launches
an external canonicalizer. The real tool always receives the original argv. Internal matching uses the C
locale; the original LC_ALL value/presence is restored before external calls.

A match is a protected root, collective removal of its direct children, a disk
device operand of dd/shred/wipefs, any mkfs format, or a diskutil erase. Plain nonrecursive rm
runs untouched. mv sources count; its destination does not. dd only examines
`of=`. Nearly all means **at least 90% of currently existing direct children and
at least two distinct children**, or every child of a nonempty root. Hidden
children and symlinks count; duplicate operands count once. Deeper descendants
do not count as direct children. With `rmdir -p`, protected ancestors also match. An empty root has no collective match.

A positive match undergoes full JSON validation, then invokes the exact guard
`client` array plus `wipe-exec` and the request JSON. The request contains v,
kind, id, threadId, tool, original argv, physical cwd and canonical targets.
**No token is passed in argv**: the client reads it from the guard file.
Exit 0 allows, 10 denies (shim exit 10), any other client outcome refuses with
exit 126. Client protocol output is suppressed. Refusals name the target on one
line, escaping control characters. No guard, invalid guard or internal analysis
fault executes the real tool. `off:true` or `MURAGE_WIPE_GUARD_OFF=1` also bypasses
matching. Allowed calls preserve the real exit code and both output streams.

These are PATH wrappers, with the scope and bypasses documented by the hybrid
design. This directory does not implement the text layer, callback server or
engine lifecycle.

## Container qualification

Run `python3 server/wipe-guard/shim/tests/test_shim.py` through the prescribed
IT runner in a network-disabled throwaway container. The fixture refuses to run
outside a container. It creates only temporary fake roots, uses a recording
client and fake real tools, then separately proves deny/allow witnesses with
`/bin/rm` against those temporary roots. It never contacts a running app.

The node:24-bookworm runner supplies dash, Bash 5, Python and su. Supply these
additional offline test assets under `WG_SHELL_ASSETS` (default `/tools/wg-shim`):
`bash-3.2` (an executable launcher if needed), `zsh`, `busybox` (ash), and `fish`.
Missing shells fail the suite. The five POSIX implementations run the actual
library; fish is a real child-shell witness that reaches the PATH shim. Shell
assets and captures belong outside the repository. Native macOS and Git Bash
runner qualification remains the platform owners' responsibility; Linux tests
exercise the actual Bash 3.2 binary and Windows path strings.

Timing compares direct and shim invocations of real rm on a nonexistent fake
file, discards ten warm-ups and measures 200 pairs for every POSIX shell.
Under MAIN 1114-WG-SHIM-TIMING the median added latency must be at most 10 ms;
the recursive cases cover 33 and 64 roots. `profile_fast_path.py` is an optional
isolated diagnostic.
