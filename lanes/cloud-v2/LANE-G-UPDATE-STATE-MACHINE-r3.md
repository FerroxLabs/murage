# Lane G `update_software`: state machine, round 3 (design only, 2026-10-24) - LAST ROUND

Grounded in `dev/fix/cloud-lane-g-update-software` @ f7713e0cb (`server/cloud-home/supervisor.ts`, `deploy/cloud-home/murage-turn.sudoers`,
`murage-home.service`, `murage-commands.service`, `start-home.sh`, `build-image.sh`, `murage-turn-launch.py`, `murage-browser-namespace.py`,
`murage-browser-network.py`, `murage-commands`, `install-launchers.py`, `launchers.txt`), the round-2 design
(`LANE-G-UPDATE-STATE-MACHINE-r2.md`, whose H1/H2/H3 mechanisms are KEPT verbatim unless a delta below names them), the Grok round-2
review (H4 open; four residual Highs, one root cause) and the Astra round-2 pass (A exact identity, B systemd-run/TOCTOU, C slot-A
unsigned bypass, D stale-drive wipe + uncounted boot starts). No code here.

**Verdict first (sec. 0):** "no release-slot byte ever executes with uid 0" IS fully achievable on this code base, at one explicit cost:
the three root launchers and the home's root prelude become **image-pinned** (changed only by re-image, never by `update_software`).
Everything the brief lists as a High closes by construction once that holds. Recommendation: **SHIP** the design.

## 0. The one root cause, and the one structural answer

Round 2 left every High open for one reason: release-slot code ran as uid 0 inside `murage-home.service` (the slot supervisor
before `setuid`, `supervisor.ts:173-190`; the slot's `murage-turn-launch.py` through `murage-turn.sudoers:2`), and that unit must
keep `CAP_SYS_ADMIN` + `CAP_LINUX_IMMUTABLE` (bwrap/pasta mounts, the placeholder freeze at `murage-turn-launch.py:2094`). A root
process with those caps defeats every file-system layer (`+i`, `ReadOnlyPaths`, `InaccessiblePaths`, 0644 trust files under a
`ReadWritePaths`), rewrites the journal, and asks PID 1 for transient units.

Round 3 removes the adversary rather than adding layers against it:

1. **Root in the home is image code only.** Every uid-0 step is done by programs installed by `build-image.sh` from the image's own
   checkout into `/usr/local/libexec` (read-only under `ProtectSystem=full`, never a `ReadWritePaths`, `+i`): the new
   `murage-home-launch`, and the three launchers `murage-turn-launch`, `murage-browser-namespace`, `murage-browser-network` as
   **regular files** (r2's symlinks into the slot are gone). Each drops to an unprivileged uid *before* exec'ing any path under
   `/opt/murage-releases`, and refuses to exec such a path while euid 0 (a runtime guard, not a convention).
2. **The slot supervisor refuses to run as root.** `supervisor.ts` loses its root prelude and asserts `getuid() !== 0`.
3. **The trust root is image-owned and read-only to everyone**, including the updater: `/usr/lib/murage-home/trust/` (key, channel,
   image sequence floor, the image slot's *signed* manifest, launcher ABI). The updater re-reads it from there on every drive.
4. **The journal is cross-checked against signed facts** (`current` vs `installed.slot`; `installed.sequence` vs the signed manifest
   of the live slot); any mismatch is Stuck. [A1] The `current` check is **phase-aware**: between the flip and the commit `current`
   may name `inflight.slot` while `installed` still names the committed slot; both slots must then verify against their own signed
   manifests (Amendment A1). Anything else is Stuck, and Stuck now stops the home explicitly.
5. **Starts are granted by a live authority, not by a field.** The home launcher asks `murage-commands` over a root-only unix
   socket (SO_PEERCRED + cgroup identity both ways) for a one-shot grant whenever an update is in flight; the inhibit is held from
   `installed` to the commit write.

What this costs: a release can no longer change the launchers or the root prelude. A release whose `launchers.txt` declares a
different launcher ABI is refused with the fixed reason `launcher_abi_mismatch` and the operator re-images (exactly the fallback,
scoped to launcher-affecting releases only). The engines, the server, the UI, the browser engine, the proxies, the MCP scripts, the
engine manifest - everything that ships today in a release - still update in place.

## 1. Privilege model

### 1.1 Image-owned root (uid 0, CAP_SYS_ADMIN, CAP_LINUX_IMMUTABLE allowed) - installed by `build-image.sh`, `+i`, never from a slot

| Program (`/usr/local/libexec/...`) | Runs as root in | Root-only steps it performs itself | Drop point |
|---|---|---|---|
| `murage-home-start` (bash, existing) | `murage-home.service` ExecStart | consume the safe-mode flag; `murage-enroll` (root; unchanged); envelope read + shape check; export FD 3 | none - `exec`s `murage-home-launch` (still root) |
| `murage-home-launch` (**new**, `python3 -I`, single file) | `murage-home.service` | read `/etc/murage-home/identity.json`; **ported from `supervisor.ts`:** `bindHomeVolume("/data", ...)`, `prepareEngineHomes`, `prepareBrokerDir`; read `state.json` + the trust root; **start gate** (sec. 3); **slot seal + digest verification through one dirfd** (sec. 1.4); open the supervisor script via that dirfd | `initgroups("murage")`, `setgid`, `setuid(murage)`; verify `getuid()==geteuid()==murage`; **then** `execve("/usr/local/bin/node", [node, "/proc/self/fd/<D>/dist-server/cloud-home-supervisor.js"], env)` with FD 3 (secrets) and the dirfd `D` inherited, env built from scratch (no `NODE_OPTIONS`, no inherited env) |
| `murage-turn-launch` (existing file, now image-pinned) | `sudo` from the server (`murage-turn.sudoers`) | plan parsing (hostile input, unchanged), cgroup leaves/scopes, **placeholder freeze (`set_immutable`, :2094 - stays here, it is already image root code once the file is image-owned)**, `immutable_path`/digest checks of slot artifacts (reads only), pasta spawn, bwrap mounts, `--in-scope`, login/enroll-key/logout modes | unchanged sites: `pasta_child` :1334 (turn user), browser restore :1804 (`murage-browser`, `drop` mandatory), `murage-browser-namespace` :720 (`murage-browser`), plus the new `exec_slot()` guard (sec. 1.3) |
| `murage-browser-namespace`, `murage-browser-network` (existing, image-pinned) | children of `murage-turn-launch` | `sysctl -w`, `nft -f`, netns, scope kill | `murage-browser-namespace` :720 before `execve(BROWSER_BWRAP ...)` (an image binary) |
| `murage-commands` (existing, image) | `murage-commands.service` | the whole updater: fetch, verify, install into the **idle** slot, flip, grant starts, commit; writes `state.json`, `manifests/<slot>`, the inhibit | never execs slot code at all (loads `plan`/`tree_digest`/`verify_manifest` only from image copies, as today) |
| `murage-enroll`, `murage-control`, `murage-egress-proxy`, `murage-backup*`, `murage-install-launchers` | their own units / build | unchanged | n/a |

### 1.2 Unprivileged slot code (never uid 0)

| Bytes from `/opt/murage-releases/<slot>` | uid | Started by |
|---|---|---|
| `dist-server/cloud-home-supervisor.js` | `murage` | `murage-home-launch` after the drop; **asserts `getuid() !== 0` at entry** |
| `dist-server/index.js` (the server) | `murage` | the supervisor (`spawn`), path `${MURAGE_RELEASE_ROOT}/dist-server/index.js`, `MURAGE_RELEASE_ROOT=/opt/murage-releases/<slot>` resolved once by the launcher |
| engines (`bin/*`), MCP proxies (`dist-server/...`), browser engine | `murage-turn-<...>` / `murage-browser` inside pasta+bwrap | `murage-turn-launch` after its existing drops |
| `browser-restore-cli.js` | `murage-browser` | `murage-turn-launch` :1814 (after :1804 drop; `drop` becomes non-optional) |

### 1.3 The `exec_slot()` guard (both launchers)

Every `os.execv*`/`subprocess`/`spawn` of a path whose realpath starts with `/opt/murage-releases/` or `/opt/murage/` goes through
`exec_slot(path, argv, env)`: it `os._exit(1)`s if `os.geteuid() == 0 or os.getuid() == 0` or if any supplementary group is 0 (the
plain uid check is the invariant; nothing cleverer). `murage-turn-launch`'s existing
`if os.getuid() == 0 or os.geteuid() == 0: os._exit(1)` after the drop (:1805) is the same check; the guard makes it uniform and
testable by grep (T-P2). The guard also refuses when the path is reached through `/opt/murage` and `realpath` is not under
`/opt/murage-releases/{A,B}`.

### 1.4 Verify-then-exec with no TOCTOU window (Astra B)

`murage-home-launch`, as root, before the drop:

1. `D = open("/opt/murage-releases/current", O_PATH|O_NOFOLLOW)` -> it must be a symlink; `S = readlink` in `{A, B}`;
   `D = openat(releases_fd, S, O_RDONLY|O_DIRECTORY|O_NOFOLLOW)`. Everything below uses `openat(D, ...)`; the path is never
   re-resolved.
2. Ancestors `/opt/murage-releases`, `/opt`, `/`: root-owned, not go-writable, not symlinks (today's `assertImmutableCode` loop).
3. **Seal walk:** depth-first from `D` with `openat(..., O_NOFOLLOW)` and `fstat` on every entry; every directory and regular file
   must be uid 0, not go-writable, and carry `FS_IMMUTABLE_FL` (read through `FS_IOC_GETFLAGS` on the fd being hashed); symlinks
   are hashed by target and must not escape the slot (realpath prefix). The walk produces `tree_digest` (r2's canonical form) from
   the **same fds**.
4. The signed manifest for `S` (`/var/lib/murage-update/manifests/S.json` + `.sig`; for a never-updated image, the copy the build
   placed there, identical to `/usr/lib/murage-home/trust/manifests/A.json`) must verify against `/usr/lib/murage-home/trust/
   release-public-key.pem`, have `treeSha256 == digest`, and have `sequence >= trust.minimumSequence`.
5. [A1] `state.json` (read as root, strict shape) -> **layout predicate `layout_ok(state, S)`** (Amendment A1, the same function
   the updater runs at drive entry): with no update in flight (or one still before the flip) `S == installed.slot` and
   `installed.sequence == manifest(S).sequence`; with `inflight.phase in {flip, verify, rollback}` `S` may be `inflight.slot`, and
   **both** the committed slot and the candidate are opened by their own dirfd, seal-walked (step 3) and matched to their own signed
   manifest (step 4). Any other shape: exit 79 `home_layout_mismatch` (Stuck for the updater too, which then stops the home).
6. Gate (sec. 3), requesting a grant for `S`. 7. Drop. 8. `execve` through `/proc/self/fd/D/...`.

Why no window: the bytes hashed are inodes with `+i` and uid 0 at hash time. Clearing `+i` needs `CAP_LINUX_IMMUTABLE` in the
initial user namespace; after sec. 1.1 the only holders are image programs, and the only one that ever clears `+i` on a slot
(`murage-commands`, `installing`) does so on the slot that `current` does **not** resolve to, re-derived at that moment (sec. 4
D). The flip (`current` move) happens only while the home is stopped (`stop_writers`), so a running supervisor's `MURAGE_RELEASE_ROOT`
never changes under it. The server child is spawned by the slot path, not the fd, and that is fine because the slot is sealed; the
supervisor script itself is exec'd by fd because it is the one exec the root launcher makes.

Cost: one hash pass over the live tree per home start (several seconds for the browser engine + engine binaries). Accepted; a
`Restart=on-failure` loop pays it each time. [A1] A start that lands inside `flip`/`verify`/`rollback` hashes both slots (two
passes); such starts are granted one at a time by the updater, so this is bounded by the attempt counters. (fs-verity would remove
it; not needed to close any High, so not in r3.)

### 1.5 systemd-run / PID 1 (Astra B)

Transient units need `org.freedesktop.systemd1.Manager.StartTransientUnit` on the system bus, which polkit grants to uid 0 and to
`admin`/`wheel` members only. After sec. 1.1 no slot code has uid 0; `murage`, `murage-turn-*`, `murage-browser` are in no admin
group (T-P3 asserts). The turn/browser sandboxes additionally have no `/run/dbus` bind (unchanged). So slot code cannot start a unit
outside `murage-home.service`, cannot survive `stop_writers`, and cannot touch slot bytes (they are `+i`, uid 0) between hash and
exec. The old root slot supervisor could do all three; that is the whole of why the old design could not close.

### 1.6 What `sudo` may run

`murage-turn.sudoers` is unchanged in text: `murage ALL=(root) NOPASSWD: /usr/local/libexec/murage-turn-launch ""`. What changes is
what that path **is**: an image-owned regular file (root 0755 `+i`), not a symlink into a slot. Two belts: `build-image.sh`
`chattr +i` on the three launchers and on `/usr/local/libexec` itself; `murage-turn-launch` at entry checks
`lstat("/usr/local/libexec/murage-turn-launch")` is a regular file, uid 0, `+i`, and equals `os.stat(__file__)` by `(st_dev, st_ino)`
(refuses to run as any other inode). No other sudoers line exists; `install-launchers.py`'s `ALLOWED` set now matters only at build.

## 2. Trust root: storage and unit deltas

```
/usr/lib/murage-home/trust/                root 0700, +i, image-written, read-only for every unit (ProtectSystem=full; not a ReadWritePaths anywhere)
    release-public-key.pem                 Ed25519 (moved from /etc/murage-home, which is a ReadWritePaths of the home unit)
    release.json                           {"channelUrl", "minimumSequence": <A's sequence>, "imageRevision": "<40hex>", "launcherAbi": "<token>"}
    manifests/A.json, A.sig                the image slot's SIGNED manifest (Q4 mandatory; build fails without it)
    launcher-abi                           the token the three installed launchers implement (same value as release.json.launcherAbi)
/var/lib/murage-update/                    root 0700, +i between writes; written ONLY by murage-commands (unchanged from r2)
    state.json                             the journal (r2 schema v2 + "format": "...-v3", see sec. 4)
    manifests/A.json, A.sig, B.json, B.sig signed manifests of installed slots (A's copied by the build; identical to the trust copy)
/run/murage-update/                        tmpfs, root 0700, created by murage-commands at start: lock (flock), gate.sock
/var/lib/murage-home/recovery-inhibit      unchanged path; held from `installed` through the commit write (sec. 3)
```

`/etc/murage-home/release.json` and `release-public-key.pem` are **removed** from the build. `murage-commands.release_config` reads
`/usr/lib/murage-home/trust/release.json` and the key on **every** `drive_update` entry and every manifest verification (no caching
across drives); `ctx["paths"]["trust"]` replaces the `config` path for these two files. A trust dir that is missing, not 0700 root,
or not `+i` is `Stuck`/`unsupported` (fail closed, fixed reason `trust_root_invalid`), never "no channel".

**Mandatory signed slot A (Astra C, Q4):** `build-image.sh` takes `MURAGE_RELEASE_MANIFEST` + `MURAGE_RELEASE_MANIFEST_SIG` (produced
by `scripts/cloud-home-release.sh` for the same `$revision`; the private key never touches the image build), verifies them against
`MURAGE_RELEASE_PUBLIC_KEY` with the checkout's trusted `verify_manifest`, checks `treeSha256 == tree_digest(/opt/murage-releases/A)`
and `revision == $revision`, then installs them in both places above. **The unsigned `installed.treeSha256` fallback of r2 sec. 4
(`rollback`) and sec. 6 is deleted**; `installed` keeps no `treeSha256` field. Every slot, in every gate (launcher start, rollback,
drive entry), is signature-gated or Stuck.

**Two-stage off-box signing (Grok ruling d, APPROVED).** The private key lives only on the signing host; the image build and the
release channel both install a signature they verify but never produce. The flow is approved only while all six conditions below hold,
and they are the spec. Each is enforced by `scripts/cloud-home-release.sh` (the producer and signing host) or by
`deploy/cloud-home/build-image.sh:455-489` (the image's stage-2 install), with no override anywhere.

1. **Stage 1 builds the tree with no private key and exports the exact bytes.** The tree is produced (git archive of the revision plus
   the build) with no key present, and the producer archives that very tree to `<arch>/murage-cloud-home-<sequence>.tar.gz`; those bytes
   are what gets published and what a home installs.
2. **The signing host recomputes `treeSha256` with the same `seal_walk_digest(False)` after the same `apply_modes`** as the home and the
   image, from the trusted checkout's own `install-launchers.py` and `murage-commands`, so the producer, image and home digests are one
   (`cloud-home-release.sh` lines for `apply_modes` then `seal_walk_digest`).
3. **The manifest (v3) binds `revision`, `arch`, the archive `sha256` and `bytes`, `treeSha256`, `launcherAbi`, and `sequence`.** The
   signature covers every one of these fields; the home refuses any manifest whose shape or fields differ.
4. **Stage 2 installs only the signature and re-checks `build-image.sh:466-477`**, with no pnpm rerun and no byte change in that block:
   it verifies the signature against the baked-in public key, requires `revision == $revision` and `launcherAbi == this image's`, and
   requires `seal_walk_digest(False)` of `/opt/murage-releases/A` to equal the manifest's `treeSha256`, then writes only the manifest,
   its signature, the key and `release.json`. The tree the manifest was signed over is the tree that is installed.
5. **No unsigned fallback.** `build-image.sh:415-416` fails the build unless the channel URL, the public key, the manifest and its
   signature are all present; the producer re-reads the published files and proves they are the signed bytes; the r2 unsigned
   `installed.treeSha256` path is deleted. The published archive is those same bytes.
6. **A manifest signed from a different build of the same revision is never forced.** A tree whose bytes differ yields a different
   `treeSha256`, so condition 4 fails the build and condition 5 fails the publish. There is no flag, no environment value and no code
   path that accepts a manifest whose `treeSha256` is not the tree in hand; a mismatch is always fail-closed, never an override.

**Build runbook: the exact three-step order (r7).** The manifest can only be signed from the finished tree, and the private key never leaves the
Mac (arm64, BSD tools), so the build is explicitly split. `build-image.sh` has no default: with `MURAGE_IMAGE_STAGE` unset it refuses.

1. **Builder, stage 1 and prepare (no key anywhere).**
   `MURAGE_IMAGE_STAGE=tree deploy/cloud-home/build-image.sh REVISION SOURCE_CHECKOUT [CONTROL_PUBLIC_KEY]` runs everything up to the signed-slot
   block (the pnpm build runs here, once), leaves the final tree unsealed in `/opt/murage-releases/A`, writes the stage 1 marker (revision,
   arch, host id, tree digest) under `/var/lib/murage-image-build/`, and stops. Then, on the same builder, copy the tree and run
   `scripts/cloud-home-release.sh prepare ARCH REVISION SOURCE_CHECKOUT TREE_COPY SEQUENCE OUT_DIR` (`ARCH` is `x86_64` or `aarch64`, explicit,
   and cross-checked against the tree's ELF binaries). It writes `OUT_DIR/<arch>/manifest.json` (unsigned) and the archive.
2. **Mac, sign (key only).** Copy `manifest.json` to the Mac and run
   `MURAGE_OPENSSL=/opt/homebrew/bin/openssl MURAGE_RELEASE_SIGNING_KEY=~/.config/murage-prod/release-signing-ed25519.pem scripts/cloud-home-sign.sh manifest.json REVISION ARCH SEQUENCE`.
   It re-checks the manifest's format, revision, arch, sequence and field shapes, signs exactly its bytes
   (`openssl pkeyutl -sign -rawin`, 64 raw bytes), verifies with the key's public half, and writes `manifest.json.sig` beside it. Copy the
   `.sig` back next to the manifest on the builder.
3. **Builder, finalize and stage 2.**
   `scripts/cloud-home-release.sh finalize ARCH REVISION OUT_DIR PUBLIC_KEY` verifies the signature and re-checks the published bytes with the
   home's own code. Then `MURAGE_IMAGE_STAGE=seal MURAGE_RELEASE_CHANNEL_URL=... MURAGE_RELEASE_PUBLIC_KEY=... MURAGE_RELEASE_MANIFEST=... MURAGE_RELEASE_MANIFEST_SIG=...
   deploy/cloud-home/build-image.sh REVISION SOURCE_CHECKOUT` (same host, same revision) refuses unless the stage 1 marker matches, recomputes
   `treeSha256` itself, requires it to equal the manifest's, installs the trust root, seals and enables the units. No pnpm runs in stage 2.

**Builder requirements (r9, from the 2026-10-25 dry run).** The builder needs at least 8 GB of RAM: a Hetzner **cx33 (x86_64) or cax21 (arm64)**, or larger.
cx23 and cax11 (4 GB) are OOM-killed by `tsc -b`, so `build-image.sh` now FAILS at the start of stage 1 when `/proc/meminfo` shows under 7400 MB (it used to warn and
carry on), and `hz-live.py image` refuses any other `--type` before creating a server (default `cx33`). Stage 1 is not re-runnable: if a previous run left
`/opt/murage-releases` or `/opt/murage` behind, it stops at the start with "fresh builder required"; rebuild on a fresh server, never repair a half-built one.
The seal (`seal_tree` in `deploy/cloud-home/build-guards.sh`) sets `+i` on regular files and directories only (`find DIR ! -type l -exec chattr +i {} +`): the pnpm tree holds
about 3000 symlinks, which `chattr` cannot flag. The seal walk (`seal_walk_digest`, in `murage-commands` and the launcher) likewise never asks a symlink for `+i`; it takes a
link by its target text, refuses an absolute target and any target that leaves the tree, and resolves a link through the other links it crosses (`a/b/up -> ../..` then
`top -> a/b/up/..` is refused). Every python helper in the build scripts runs with `-B` so no `__pycache__` dirties the source checkout that stage 2 requires clean.

**Staging images (r8): `deploy/cloud-home/qualify/hz-live.py image` runs these three steps itself,** in this order and stopping at the first failure:
stage tree over SSH; `cloud-home-release.sh prepare ARCH REV ... SEQUENCE OUT` on the builder; `manifest.json` copied back to the machine running the
driver; `scripts/cloud-home-sign.sh` run LOCALLY there; the `.sig` and the public key (derived locally) copied to the builder; `finalize`; stage seal
with `MURAGE_RELEASE_CHANNEL_URL`; then the snapshot. Required options, no defaults, checked before any server is created: `--release-signing-key PATH`
(the key only ever reaches the local sign script through its environment, never an ssh/rsync argument and never the builder), `--release-channel URL`,
`--release-sequence N`; optional `--openssl PATH` (default `/opt/homebrew/bin/openssl` on macOS; LibreSSL refused). ARCH is derived from the builder
lane (`--lane arm` on a `cax*` type is `aarch64`, otherwise `x86_64`), checked against the builder's `uname -m`, and passed explicitly. The driver refuses
the production release key (any path resolving under `~/.config/murage-prod/`, or a key whose public half is the production release public key) and the
production channel `https://releases.murage.ai/cloud-home`.

**Downgrade floor (Grok H4 (2)):** `floor = max(trust.minimumSequence, signed_sequence(live slot))`, where the live slot is
`readlink(current)` and its sequence comes from the signature-verified `manifests/<slot>.json`. `installed.sequence` in `state.json` is
cross-checked against the signed value and is Stuck on mismatch; it never *decides* the floor. Writing `installed.sequence = 0` buys
nothing, and in r3 nothing in the home unit can write it anyway.

### Unit deltas

`deploy/cloud-home/murage-home.service`
- `After=` add `murage-commands.service`; add `Wants=murage-commands.service`. **Not `Requires=`:** systemd propagates an explicit
  stop/restart of a `Requires=` dependency to the dependent, so every `murage-commands` restart (`Restart=always`, `RestartSec=60`,
  `murage-commands.service:20-21`) would restart the customer's home. The gate does not need `Requires=`: with an update in flight the
  launcher refuses to start unless `murage-commands` grants (sec. 3), so an absent updater means "home stays stopped", not "home
  boots unverified". [A1] **Grok confirmed `Wants=` in the r3 review; the decision stands.** Its one consequence is named and
  handled: `Wants=` never stops a home that is already up, so wherever the design says "home stopped" (Stuck, rollback entry) the
  **updater issues the stop itself**: `stop_writers(ctx)` = inhibit write, then `systemctl stop murage-home.service
  murage-turns.slice murage-browsers.slice`, then confirm inactive (today's `murage-commands:991-999`, `WRITERS` :954). Amendment A1
  names the two sites.
- **Remove** `ConditionPathExists=!/var/lib/murage-home/recovery-inhibit` from this unit (it stays on `murage-home-recover.service`).
  The inhibit is now enforced by `murage-home-launch` (image root code, before any slot byte), which is what lets the updater hold
  the inhibit through verify yet still start the home itself. PID 1 cannot express "blocked for everyone except one caller".
- `RestartPreventExitStatus=78 79` (79 = "refused by gate/seal/layout; the updater or an operator must act").
- Add `ReadOnlyPaths=/opt /var/lib/murage-update` (the launcher reads `state.json` as root; after the drop the 0700 dir is opaque).
  The trust dir is deliberately NOT `InaccessiblePaths`: the launcher reads it before the drop, and it is already read-only
  (`ProtectSystem=full`) and 0700. `ReadWritePaths=/etc/murage-home` stays (`murage-enroll`), and nothing trusted lives there any
  more.
- Comment block: the `CapabilityBoundingSet` note from r2 stays true (caps are needed by the image launchers) and is now harmless.

`deploy/cloud-home/murage-commands.service`
- `ReadWritePaths=` add `/var/lib/murage-update` (has `/opt`, `/run`). `RuntimeDirectory=murage-update`, `RuntimeDirectoryMode=0700`.

`deploy/cloud-home/murage-home-recover.service`: unchanged (its `ConditionPathExists` on the inhibit is still right: the recover
timer must never start a home mid-transition; the updater starts it itself).

## 3. Start gate: exact execution identity (Astra A), inhibit until commit, counted starts (Astra D/H6)

Replaces r2's `start_home(ctx, cid)` / `recovery_pending(ctx, cid)` own-cid exemption **entirely**. `commandId` is no longer
consulted for any start decision; it only names the command whose outcome is reported.

**Server side (`murage-commands`):** at `run()` start a thread serves `/run/murage-update/gate.sock` (root 0600). It holds one
in-memory `grant`: `None` or `{driveId, slot, phase}` set by the drive that is currently inside `verify` or `rollback(restored)`,
immediately after it has written its attempt counter. A connection is accepted only if `SO_PEERCRED` gives `uid == 0` and
`/proc/<pid>/cgroup` is exactly `0::/system.slice/murage-home.service` (checked via a `pidfd_open(pid)` taken before and compared
after the read, so a recycled pid cannot pass) and `/proc/<pid>/exe` is `/usr/bin/python3*`. The request is `{slot}`; the reply is
`grant` iff `grant is not None and grant.slot == slot`; the grant is **consumed** (set to `None`) on reply. One grant = one start of
slot code. Anything else -> `deny`.

**Client side (`murage-home-launch`), after the layout predicate (sec. 1.4 step 5, Amendment A1) and before the drop:**

| `state.json` | inhibit file | action |
|---|---|---|
| `inflight == null` | absent | normal start, no gate contact |
| `inflight == null` | present | this is a reset/undo transition, or the post-commit instant before the updater lifts it: **exit 79** (the updater's `start_home` after lifting re-issues the start) |
| `inflight.phase == installing` | absent | normal start (the live slot is untouched by construction; [A1] committed group of the predicate: `S == installed.slot` already required) |
| `inflight.phase in (installed, flip)` or `rollback(restored=false)` | any | exit 79 ([A1] reason `gate_phase`, not `home_layout_mismatch`: in `flip`/`rollback` `S` may already be the candidate or the restored slot and the predicate has accepted it) |
| `inflight.phase in (verify, rollback(restored=true))` | present (always, in r3) | [A1] predicate (transition group) has verified both slots; connect to the gate as root; `grant` for `S` -> continue; `deny`/no socket/peer not `murage-commands.service` (checked by the client too: `SO_PEERCRED` uid 0 + cgroup `murage-commands.service`) -> exit 79 (reason `gate_denied`) |
| unreadable / wrong shape / unknown phase / [A1] layout predicate fails (A1 table: `S` outside the phase's allowed set, `inflight.slot == installed.slot`, either slot fails its own seal or manifest) | any | exit 79 (reason `home_layout_mismatch`); the updater Stucks on the same predicate and issues the explicit stop |

[A1] The exit code stays 79 for every refusal (`RestartPreventExitStatus=78 79`); the reason is one fixed token on stderr
(`gate_phase | gate_denied | home_layout_mismatch | slot_seal_failed | trust_root_invalid`), which is what the tests assert on.

**Consequences**
- *Boot during verify:* `/run` is empty, `murage-commands` has not granted; the home unit (ordered `After=`) runs the launcher, which
  exits 79 and stops. `murage-commands.run()` -> `drive_update` -> `verify` handler: `verifyAttempts += 1` (write), set grant,
  `systemctl start murage-home`, `wait_healthy`. **Every start of slot code in verify is preceded by the counter write**: the
  counter is a true bound on executions, including systemd's own restarts, which are denied without a fresh grant (H6 closed).
- *Forged journal start (Astra A):* there is no journal field that produces a start. A start in `verify` needs a live grant inside
  the `murage-commands` process that is driving, delivered to a peer that PID 1 placed in `murage-home.service`. Nothing in the
  slot can write `/run/murage-update` (0700 root, outside the home unit's writable set) or impersonate the updater's cgroup.
- *Inhibit until commit (point 4):* `stop_writers` sets the inhibit at `installed`; nothing removes it until the commit write has
  landed (`installed := new, inflight := null, lastResult := done`, fsync'd). Only then: `remove(inhibit)`; `systemctl start` (idempotent,
  covers a crash in the window where the launcher exits 79 on "inhibit present, inflight null"). Rollback-complete removes it in the
  same order after its own healthy observation.
- *Rollback starts are counted too:* `rollbackAttempts` 0..3, incremented before each grant; at 3 unhealthy -> **Stuck** (home stopped
  [A1] explicitly by the updater's `stop_writers`, see Amendment A1; operator). This replaces r2 Q3's "left running under systemd
  forever" (systemd restarts cannot happen without grants now).
- `reset_from_backup`/`undo_reset` are unchanged in behaviour: they set the inhibit, swap, lift, `systemctl start`; the launcher sees
  no inhibit and `inflight == null` and starts normally. They never need the gate.
- `restart_service`, `safe_mode`: `systemctl restart` -> launcher -> normal start.

## 4. State machine deltas from r2 (phase set unchanged: `installing | installed | flip | verify | rollback`)

`state.json` `format` becomes `murage-cloud-home-update-state-v3`: `installed = {slot, sequence, revision}` (no `treeSha256`);
`inflight` gains `driveId` (random 128-bit, new per `drive_update` invocation, in-memory only, mirrored into the record for logs),
`rollbackAttempts`; `verifyAttempts` 0..2 unchanged.

**Drive entry (every invocation, before anything else):** `flock(/run/murage-update/lock)` (poll loop and `--recover-update` can
never interleave; a second holder raises `Pending`); re-read trust root (sec. 2) -> `Stuck` if invalid; `read_update_state` (strict)
-> `Stuck` if invalid; [A1] **`layout_ok(state, readlink(current))`** (Amendment A1; the identical predicate the launcher runs):
with `inflight == null` or `inflight.phase in {installing, installed}` it is today's rule, `readlink(current) == installed.slot` and
the signed manifest of the live slot verifies with `sequence == installed.sequence`; with `inflight.phase in {flip, verify, rollback}`
`installed` stays the committed slot, `current` may resolve to `inflight.slot`, and each of the two slots must pass its own seal walk
and its own signed manifest; any other shape is `Stuck(home_layout_mismatch)` (point 3). These checks also run inside
`recovery_pending` (fail closed; it never stops anything itself, it only answers). [A1] **Every `Stuck` raised from `drive_update`
is preceded by `stop_writers(ctx)`** (one site, the `Stuck` handler at the top of `drive_update`): the home is stopped explicitly
because `Wants=` will not stop a home that is already up.

| Phase | r2 behaviour kept | r3 delta |
|---|---|---|
| idle -> installing | preflight, `revision == installed.revision -> done`, deadline | floor is `max(trust.minimumSequence, signed live sequence)`; manifest v3 adds `launcherAbi`, must equal `trust.launcherAbi` else `failed/launcher_abi_mismatch` (fixed reason; the Cloud UI shows "needs a fresh home image") |
| installing | download, `safe_extract`, `plan()`, `tree_digest`, store manifest, seal | **wipe target re-derived at wipe time (Astra D):** inside the lock, immediately before `rmtree`: `live = readlink(current)`; require `inflight.slot != live`, `inflight.slot != installed.slot`, `installed.slot == live`, and `fstat(slot_dirfd).st_ino != fstat(live_dirfd).st_ino`; any failure -> `Stuck`, `+i` on `/opt/murage-releases` is lifted only after this passes; `rmtree` runs on the dirfd (`O_NOFOLLOW`). **Seal:** after digest, `+i` on every regular file and directory in the slot (not only the root), then on `/opt/murage-releases`. `verify_links()` is gone (no libexec links); `apply_modes` stays. Launchers in the release tree (`deploy/cloud-home/*.py`) are extracted like any file but are never installed anywhere. |
| installed -> flip | `stop_writers` sets inhibit | unchanged; the inhibit now persists until commit |
| flip | symlink+rename `current` | unchanged |
| verify | attempts bound 2; `wait_healthy` observed by the updater; commit = one write | **no `remove(inhibit)`**; `verifyAttempts += 1` -> write -> `grant = {driveId, slot}` -> `systemctl start` -> `wait_healthy` (unit active AND `murage-control.app_responding`, 2 passes/180 s). Healthy: commit write, then lift inhibit, `systemctl start`. Unhealthy or unit inactive: `phase = rollback` (write), [A1] then `stop_writers(ctx)` immediately (rollback entry; the unhealthy candidate may still be up and `Wants=` will not take it down). On resume at verify with the unit already active (cannot happen in r3 without a grant; if it is active anyway - e.g. `murage-commands` crashed after granting - `wait_healthy` just observes, same as r2). [A1] On resume at verify after a reboot or updater restart: drive entry's predicate accepts `current == inflight.slot`, so the handler is reached and the candidate IS health-checked under a counted grant (the r3 text had it Stuck before the gate) |
| rollback, restored=false | integrity gate, flip back | [A1] **entry: `stop_writers(ctx)` first, on every entry and every resume** (idempotent: `systemctl stop` of an inactive unit is a no-op), so the flip-back rename never happens under a running home; then gate = **signed manifest only** for every slot (no `installed.treeSha256` branch); the seal walk (every inode `+i`, uid 0) is part of the gate; flip back; `restored = true` |
| rollback, restored=true | start, probe per poll | `rollbackAttempts += 1` -> write -> grant -> `systemctl start`; healthy (2 passes): `inflight = null, lastResult = failed/<reason>`, lift inhibit. `rollbackAttempts == 3` and unhealthy -> `Stuck` ([A1] which stops the home) |
| any Stuck | raise; nothing cleared | unchanged journal semantics; [A1] `stop_writers(ctx)` is issued before the raise (home and slices stopped, inhibit set; re-issued on every poll while Stuck, harmless); `--recover-update` has no flags (I3) |

`start_home(ctx, cid=None)` becomes `start_home(ctx)`: `if recovery_pending(ctx): return 0` (no exemption parameter). The update
never calls it during verify/rollback; it uses `grant_and_start(ctx, slot)`.

## 5. Failure list deltas (r2 sec. 5 rows stand; these rows change or are new)

| Failure point | On disk | Recovery |
|---|---|---|
| Power loss during verify | inhibit **present**, `verifyAttempts = n`, `current` = new, `installed` = old | [A1] boot: the launcher's predicate (transition group) accepts `current == inflight.slot`, seal-walks and signature-checks both slots, then asks the gate: no grant at boot -> exit 79 `gate_denied` (not `home_layout_mismatch`). `murage-commands` drives: its own predicate accepts the same layout, so the verify handler is reached: n>=2 -> rollback (entry stops the home, flips back), else n+1, grant, start, `wait_healthy` **observes the candidate**. The unverified tree never ran at boot on its own, and it is never left live without a health verdict. |
| [A1] `murage-commands` restart (crash, `Restart=always`) after the `current` rename, before commit (phase `flip` or `verify`) | inhibit present, `current` = new or old (flip) / new (verify) | drive entry predicate accepts both shapes; `flip` handler re-runs the idempotent symlink+rename then `verify`; `verify` proceeds as above. No Stuck, rollback stays reachable. |
| [A1] Power loss during rollback (restored=false or true) | inhibit present, `current` = new or old | predicate accepts either (`restored=false`), or old only (`restored=true`); handler entry `stop_writers` (no-op after a boot), gate, flip back if still needed, counted start of the old slot. |
| `murage-commands` crashes after granting, before `wait_healthy` | home running (one start happened), grant gone | next `murage-commands` start: `drive_update` at verify; `wait_healthy` observes the running home (no new start without a new counted grant). |
| Home crashes during verify (systemd `Restart=`) | - | launcher asks gate, denied (grant consumed) -> exit 79 -> unit stops -> `wait_healthy` sees inactive -> rollback (or next counted attempt). |
| Slot-code process asks PID 1 for a transient unit | - | denied by polkit (uid != 0, no admin group). T-P3. |
| Anything in the home unit tries to modify a live slot byte | - | EPERM: `+i`, uid 0, no `CAP_LINUX_IMMUTABLE` holder outside image code. T-P4. |
| Live slot fails the seal/digest at start (bit rot, operator edit) | - | launcher exit 79 `slot_seal_failed`; home stopped; `drive_update` next poll: layout checks pass but the slot digest fails -> `Stuck`; operator re-image (recoverable: data volume untouched). |
| `current != installed.slot` with `inflight == null` or `inflight.phase in {installing, installed}` (any cause) | - | launcher 79 `home_layout_mismatch`; updater `Stuck(home_layout_mismatch)` and [A1] `stop_writers` (home explicitly stopped if it was up); blocked kinds refused. |
| [A1] `current != installed.slot` with `inflight.phase in {flip, verify, rollback}` and `current == inflight.slot`, both slots verify | - | **not a mismatch**: this is the post-flip, pre-commit layout. Launcher: predicate passes, gate decides. Updater: handler for the phase runs (verify health-checks the candidate; rollback flips back). |
| [A1] `current` names neither `installed.slot` nor `inflight.slot`, or `inflight.slot == installed.slot`, or a slot fails its own seal/manifest during a transition | - | launcher 79 `home_layout_mismatch`; updater `Stuck` + `stop_writers`. A corrupted candidate during `verify` is Stuck, not rollback: its manifest and seal were written by the updater in `installing`, so a failure there is tampering or media corruption and an operator looks before anything is flipped. |
| [A1] Stuck of any kind while the home happens to be active | - | `stop_writers` in the `drive_update` Stuck handler stops `murage-home.service` + the two slices and confirms inactive; re-issued each poll. `Wants=` alone would have left it running. |
| Stale drive tries to wipe the live slot | - | impossible: the wipe target is re-derived from `current` under the lock at wipe time and must differ by inode from the live slot. T-D1. |
| `installed.sequence` rewritten lower | - | nothing in the home unit can write it; if it were (operator), drive entry cross-check vs the signed manifest -> `Stuck`. |
| Trust dir missing/altered | - | cannot happen without re-imaging (read-only, `+i`, image-written); if it does, `Stuck(trust_root_invalid)` and the launcher refuses to start the home (no key -> no verified slot). This is deliberate: a home with no trust root is a home we cannot vouch for. |
| Release needs a launcher change | - | refused at idle with `launcher_abi_mismatch`; home untouched; operator re-images. |
| Launcher inode replaced | - | `murage-turn-launch` self-check (`st_ino`, `+i`, regular file) fails -> turns refuse; the home is otherwise fine. |

## 6. The r2 Highs (Grok) and Astra findings -> why each is now impossible

| # | Round-2 finding | Impossible because |
|---|---|---|
| G-H4.1 | Root slot code rewrites the trust root (`release-public-key.pem`, `release.json` 0644 under `ReadWritePaths=/etc/murage-home`) | No slot byte runs as root (sec. 1). The trust root is `/usr/lib/murage-home/trust` (0700, `+i`, read-only under `ProtectSystem=full` for **every** unit, in no `ReadWritePaths`), re-read on each drive. `/etc/murage-home` holds nothing trusted. |
| G-H4.2 | Root clears `+i`, unmounts `InaccessiblePaths`, writes `installed.sequence = 0`, rewrites slot A (manifest optional) | No root slot code, so no `CAP_LINUX_IMMUTABLE`/`CAP_SYS_ADMIN` in attacker hands. Floor is derived from the image minimum and the *signed* live manifest; `installed.sequence` is cross-checked, never decisive. Slot A's manifest is mandatory and signed; the unsigned digest path is deleted. |
| G-H4.3 | Forge `installed.slot` / `inflight = null` so `installing` wipes the live tree or a 2nd update passes the gate | No writer of `state.json` exists in the home unit. Independently: `current` vs `installed.slot` mismatch is Stuck at drive entry and in the launcher ([A1] phase-aware: tolerated only while an in-flight record in `flip`/`verify`/`rollback` names that slot as its candidate and both slots verify against their own signed manifests; the wipe in `installing` still requires `current == installed.slot`); the wipe target is re-derived from `current` at wipe time with an inode inequality; the sequence floor comes from signed data, so a forged `inflight = null` cannot admit a downgrade. |
| G-H4.4 | Inhibit lifted before `wait_healthy`; no `After=`; a verify crash boots the unverified tree as root | Inhibit held to the commit write; `After=/Wants=murage-commands.service` ([A1] `Wants=` confirmed by Grok; the explicit stop on Stuck and at rollback entry covers what `Wants=` does not); the launcher refuses any start during `verify`/`rollback` without a live grant, and at boot there is none ([A1] the predicate now lets that start reach the gate, so the candidate is health-checked under a counted grant instead of being stranded live and unverified across a boot). Even if a start happened, the slot runs as `murage`, never as root. |
| A-A | `inflight.commandId` exemption forgeable (any real CID + `phase=verify`) | The exemption is gone. A start needs a one-shot grant from the live `murage-commands` process, authenticated both ways by `SO_PEERCRED` + cgroup (`murage-commands.service` <-> `murage-home.service`), consumed on use. No journal field participates. |
| A-B | `systemd-run` transient service outlives `stop_writers`; modifies slot bytes between hash and exec | Slot code is uid != 0 and in no admin group -> `StartTransientUnit` denied (T-P3). Slot bytes are `+i` uid 0; the launcher hashes and execs through one dirfd on inodes it verified immutable (sec. 1.4); the only `+i`-clearing program never targets the live slot. |
| A-C | Slot-A rollback gate accepted mutable `installed.treeSha256` without a signature | Deleted. Slot A's signed manifest is produced by the release script, verified at image build, installed in the trust dir and `manifests/`. Every slot in every gate is signature-checked. |
| A-D (H5) | Stale journal/drive makes the idle-slot `rmtree` hit the live slot | Wipe target re-derived from `readlink(current)` under the drive lock at wipe time; must differ from `current`, from `installed.slot`, and by inode from the live dirfd; `+i` on the releases dir lifted only after. |
| A-D (H6) | Boot-initiated starts not counted by the 2-attempt verify bound | Every start of slot code in verify/rollback requires a grant, and every grant is preceded by the counter write. Boot and `Restart=` starts without a grant exit 79 and run no slot code. |

## 7. Concrete per-file deltas (the r2 sec. 6 deltas stand unless named here)

### NEW `deploy/cloud-home/murage-home-launch.py` -> `/usr/local/libexec/murage-home-launch` (root 0755, `+i`)
- `python3 -I`, single file, imports stdlib only; constants `RELEASES`, `TRUST`, `UPDATE_STATE`, `GATE_SOCK`, `NODE`, `HOME_USER`.
- `read_identity()` (port of `parseHomeIdentity`), `bind_home_volume()` (port of `bindHomeVolume`: **port 1:1, the current TS is the
  spec; T-P5 diffs the resulting tree**), `prepare_engine_homes()`, `prepare_broker_dir()` (ports of the two functions at
  `supervisor.ts:31-50`, same modes 0711/02770 and owners).
- `open_live_slot()` (sec. 1.4 steps 1-2), `seal_walk_digest(dirfd)` (step 3; `tree_digest` canonical form copied from the
  checkout's `murage-commands` at build - same trusted-copy rule as `plan`), `verify_slot_manifest(slot, digest)` (step 4; Ed25519
  via `openssl pkeyutl -verify` as `murage-commands` does today), [A1] `layout_ok(state, slot)` (step 5, Amendment A1; replaces
  `check_journal`; opens and verifies the second slot through its own dirfd when the phase is `flip`/`verify`/`rollback`),
  `gate_decision(state, inhibit)` (sec. 3 table; `connect` + `SO_PEERCRED` + cgroup check of the peer), `drop_privileges(identity)`,
  `exec_supervisor(dirfd, env)`. [A1] `layout_ok` is one function kept byte-identical in `murage-home-launch.py` and
  `murage-commands` (same trusted-copy rule as `tree_digest`; T-S4 diffs them).
- Exit codes: 78 unchanged meaning (stale generation, from enroll), 79 = refused (gate/seal/layout/trust), 1 = error.
- Env passed to node, built from scratch: the existing `home.env` names (`set -a` in `start-home.sh` is replaced by the launcher
  reading `/etc/murage-home/home.env` itself and allowlisting keys), `MURAGE_CLOUD_SECRETS_FD=3`, `MURAGE_SAFE_MODE`,
  `MURAGE_RELEASE_ROOT=/opt/murage-releases/<S>`, `MURAGE_HOME_IDENTITY=<json>` (so the supervisor need not read `/etc` as `murage`).

### `deploy/cloud-home/start-home.sh`
- Keep lines 1-52 (safe-mode flag, `murage-enroll`, envelope read/validate, FD 3). Replace the final
  `exec /usr/local/bin/node /opt/murage/dist-server/cloud-home-supervisor.js` with
  `exec /usr/bin/python3 -I /usr/local/libexec/murage-home-launch`. Drop the `set -a; . home.env; set +a` (the launcher does it).

### `server/cloud-home/supervisor.ts`
- Delete the root prelude: `:173` (`getuid !== 0` throw) becomes `if (process.getuid?.() === 0) throw new Error(cloudHomeCopy.homeSupervisorMustNotRunAsRoot)`;
  delete `:175 assertImmutableCode("/opt/murage")` call? **No - keep it**, pointed at `process.env.MURAGE_RELEASE_ROOT` (must match
  `/^\/opt\/murage-releases\/(A|B)$/`), as a second, unprivileged check; delete `bindHomeVolume`, `prepareEngineHomes`,
  `prepareBrokerDir` calls and the `initgroups/setgid/setuid` lines `:185-190`. `parseHomeIdentity` stays (parses
  `MURAGE_HOME_IDENTITY`); the three prepare/bind functions move out of this file (they are now spec for the Python port; keep them
  exported under `server/cloud-home/home-volume-spec.ts` for the T-P5 diff test, not loaded at runtime).
- `:202 serverArgs: ["/opt/murage/dist-server/index.js"]` -> `[\`${releaseRoot}/dist-server/index.js\`]`.
- `TURN_LAUNCHER` and all `sudo` call sites (`turn-process.ts:118`, `browser-process.ts`, `engine-login.ts`, `b1b-recovery.ts`):
  unchanged (`/usr/local/libexec/murage-turn-launch`).

### `deploy/cloud-home/murage-turn.sudoers`
- Text unchanged. Comment line added: "image-owned regular file, +i; never a link into a release slot (LANE-G r3 sec. 1.6)".

### `deploy/cloud-home/murage-home.service`
- As sec. 2: `After=` + `Wants=murage-commands.service`; remove `ConditionPathExists`; `RestartPreventExitStatus=78 79`;
  `ReadOnlyPaths=/opt /var/lib/murage-update`; comment block updated (the privilege-drop comment now says "performed by
  `murage-home-launch`; the slot supervisor refuses uid 0").

### `deploy/cloud-home/murage-commands.service`
- `ReadWritePaths=` add `/var/lib/murage-update`; `RuntimeDirectory=murage-update`, `RuntimeDirectoryMode=0700`.

### `deploy/cloud-home/build-image.sh`
- Slots and links as r2 (`/opt/murage-releases/A`, `current -> A`, `/opt/murage -> murage-releases/current`; `chown/chmod -R` on
  `/opt/murage-releases`).
- `:305-309` launcher install: `murage-install-launchers deploy/cloud-home /usr/local/libexec` now installs the three as **regular
  files** (copy, tmp+rename, root 0755) from the build checkout, then `chattr +i` each and `/usr/local/libexec`.
- Install `deploy/cloud-home/murage-home-launch.py` -> `/usr/local/libexec/murage-home-launch` 0755 `+i`.
- `:400-407` replaced: require `MURAGE_RELEASE_CHANNEL_URL`, `MURAGE_RELEASE_PUBLIC_KEY`, `MURAGE_RELEASE_MANIFEST`,
  `MURAGE_RELEASE_MANIFEST_SIG` (all four, or the build **fails**; the "unsupported" no-channel image is gone - staging builds use the
  staging key); verify the manifest (trusted checkout `verify_manifest`), check `revision == $revision` and `treeSha256 ==
  tree_digest(/opt/murage-releases/A)`, check `launcherAbi == $(cat deploy/cloud-home/launcher-abi)`; write
  `/usr/lib/murage-home/trust/{release-public-key.pem, release.json, launcher-abi, manifests/A.json, A.sig}` 0600 in a 0700 dir;
  copy `manifests/A.*` to `/var/lib/murage-update/manifests/`; write `state.json` v3 (`installed = {A, <manifest.sequence>,
  <revision>}`); seal: `chattr +i` recursively on `/opt/murage-releases/A`, on `/opt/murage-releases`, on `/var/lib/murage-update`
  (+ files), on `/usr/lib/murage-home/trust` (+ files). Delete the `/etc/murage-home/release*.{pem,json}` lines.
- Test hook `:438` extended: assert the four launchers are regular files with `+i`, and the trust dir exists.

### `deploy/cloud-home/install-launchers.py`
- Keep `LauncherError`, `ALLOWED`, `MODE`, `parse`, `plan`, `_fsync_dir`. Delete `stage/prepare/swap/restore/cleanup/_new/_prev/_unlink`
  **and** r2's `install`-as-symlinks/`verify_links`. `install(source_dir, dest_dir)` copies regular files (build only).
  `abi(source_dir)` returns the `abi <token>` line of `launchers.txt`; `check_abi(release_tree, trust_abi)` is what the updater calls
  at idle (fixed reason `launcher_abi_mismatch`). `launchers.txt` gains a first non-comment line `abi murage-launchers-1`; the
  three file rows stay (they document what the image pins; the floor-of-three rule now means "a release must still ship the
  sources the image was built from", checked by `plan()` for the ABI line's sake only).

### `deploy/cloud-home/murage-turn-launch.py`
- **The freeze does not move**: `set_immutable` (:2094) stays in this file, which is now image root code. Nothing in the turn path
  changes shape; this is why the design is achievable without touching the turn protocol.
- Add `exec_slot(path, argv, env)` (sec. 1.3) and route the exec sites that can name slot paths through it (`:1814` browser
  restore, `:5917 --child`, `:5907` browser binary, `:227`, `:1010`, `:5481`); `drop` at `:1803` becomes unconditional.
- Add the self-inode check (sec. 1.6) at `main()` entry. `MCP_PROXY_ROOT = "/opt/murage/dist-server"` (:2569) is unchanged (read
  and hashed as root, executed only inside the sandbox as the turn user).

### `deploy/cloud-home/murage-browser-namespace.py`, `murage-browser-network.py`
- No functional change; both are now image-pinned regular files. `immutable_artifact(HELPER)` keeps working (regular file path).

### `deploy/cloud-home/murage-commands`
- r2 sec. 6 deltas stand, then: `release_config` reads `TRUST` (`/usr/lib/murage-home/trust`) and validates the dir (0700 root `+i`);
  `ctx["paths"]["trust"]`; `verify_manifest` v3 adds `launcherAbi` (exact field set grows by one); `read_update_state` v3 shape;
  **remove** every `cid` parameter from `start_home`/`recovery_pending`; add `gate_server(ctx)` thread + `grant_and_start(ctx, slot)`;
  `drive_update` entry: `flock`, trust re-read, [A1] `layout_ok(state, readlink(current))` (phase-aware, Amendment A1) + signed-sequence
  cross-checks; [A1] `drive_update` wraps its body in one `except Stuck: stop_writers(ctx); raise`; `rollback_update` keeps its
  `stop_writers(ctx)` at entry (today's :836) and the `restored=false` resume path calls it too; `wipe_slot` re-derivation (sec. 4);
  `seal_slot` recursive `+i`; `slot_integrity` = seal walk + signed manifest only (delete the `expected_digest` fallback parameter);
  verify/rollback handlers per sec. 4 (no inhibit lift before commit; counters before grants; `rollbackAttempts`); commit then
  `remove(inhibit)` then `systemctl start`; `release_stale_inhibit` unchanged (`not recovery_pending(ctx)`).
- `main()`: `--recover-update` unchanged; the gate is also served while it runs (same thread).

### `scripts/cloud-home-release.sh`
- Manifest v3: `+launcherAbi` (from the built tree's `launchers.txt`), `treeSha256` as r2; also emits the manifest+sig pair the image
  build consumes for slot A (same artefact as the channel's).

## 8. Tests (fixture `server/cloud-home/home-commands.fixture.py` + `supervisor.test.ts` + `qualify/negative-tests.sh`; r2 sec. 7 tests
ride along, with T-I2b and T-H4c rewritten as below)

| Id | Pins | Test |
|---|---|---|
| T-P1 | sec. 1 (the invariant) | qualify, real home: for the full life of a turn, a browser session, a login and a home start, sample `/proc/*/status` (Uid) + `/proc/*/exe` + `/proc/*/maps` of every process in `murage-home.service`'s cgroup and the turn/browser slices: no process with uid 0 has `exe` or any mapped file under `/opt/murage-releases/`. Fail on a single hit. |
| T-P2 | sec. 1.3 | grep-level: every `execv*`/`Popen`/`spawn` in `murage-turn-launch.py` and `murage-home-launch.py` whose argument can resolve under `/opt/murage*` is `exec_slot`; unit test: `exec_slot` with euid 0 exits 1 and does not exec. |
| T-P3 | sec. 1.5 | qualify: as `murage`, `murage-browser`, a turn uid: `systemd-run --system true` and a raw `StartTransientUnit` D-Bus call are denied; none of those uids is in `admin`/`wheel`/`sudo` beyond the single sudoers rule. |
| T-P4 | sec. 1.4 | qualify: as `murage` (post-drop) and from inside a turn: write/`chattr -i`/`rename`/`unlink` on any live-slot path -> EPERM/EROFS; as root from `murage-commands` on the **idle** slot -> allowed (so the updater still works). |
| T-P5 | sec. 7 port | fixture: run the Python `bind_home_volume`/`prepare_engine_homes`/`prepare_broker_dir` and the TS originals against the same scratch tree; diff `find -printf '%p %m %u %g %y\n'` output: identical. |
| T-P6 | sec. 1.4 | unit: the seal walk refuses a slot with one file lacking `+i`, one go-writable dir, one non-root inode, one symlink escaping the slot; accepts the sealed fixture; its digest equals `murage-commands.tree_digest` for the same tree. The exec'd script path begins with `/proc/self/fd/`. |
| T-P7 | sec. 1.2 | `supervisor.test.ts`: `startHomeSupervisor` throws when `getuid() === 0`; accepts `MURAGE_RELEASE_ROOT=/opt/murage-releases/A`; rejects `/opt/murage`, `/opt/murage-releases/C`, a go-writable ancestor. |
| T-T1 | sec. 2 | fixture: `release_config` reads only under `trust/`; with `/etc/murage-home/release.json` present and `trust/` absent -> `Stuck(trust_root_invalid)`, no fetch. A trust dir 0755 or without `+i` -> same. |
| T-T2 | sec. 2 (floor) | fixture: `installed.sequence` forged to 0 while the live slot's signed manifest says 7: an update with sequence 5 is refused (`downgrade`), and drive entry is `Stuck` on the cross-check; with `installed.sequence = 7` it proceeds. |
| T-T3 | Astra C | fixture + build test: image build without any one of the four release inputs fails; `manifests/A.sig` corrupted -> rollback to A is `Stuck`; no code path accepts a digest without a verified signature (grep: `slot_integrity` has one signature of `(ctx, slot)`). |
| T-G1 | Astra A | fixture gate: a client whose peer cgroup is not `murage-home.service`, or uid != 0, or that connects when no drive is in verify, gets `deny`; the correct peer gets exactly one `grant` per counter write; the second request is `deny`. Forged `inflight.commandId` = a pending reset's CID produces no grant and no start (count `systemctl start` calls = 0). |
| T-G2 | Astra D (H6) | fixture: in `verify`, simulate boot (`/run` empty) then three systemd restarts: `systemctl start` is called only by the updater, `verifyAttempts` reaches 2, then `rollback`; the launcher seam exits 79 on every ungranted start; total slot-code starts == counter value. [A1] The fixture lays the disk out post-flip (`current -> B`, `installed.slot == A`, `inflight.slot == B`); every ungranted 79 carries reason `gate_denied`, never `home_layout_mismatch`; each granted start is of slot B and `app_healthy` is probed against it (probe count > 0 per attempt); on `rollback` entry `systemctl stop murage-home.service` appears in the call log before any rename of `current`. |
| T-G3 | point 4 | fixture: the inhibit file exists continuously from `stop_writers` to the commit write (assert on the write log that `remove(inhibit)` follows `installed := new` and never precedes `wait_healthy == True`). Same for rollback-complete. |
| T-G4 | sec. 3 table | launcher seam: for each (phase, inhibit) cell the exit code / gate contact is exactly the table's. [A1] Each cell is run under every `current` value its phase allows (A1 table) and asserts the stderr reason token; the transition cells additionally assert both slots were seal-walked (two dirfd walks in the call log). |
| T-G5 | availability | qualify: `systemctl restart murage-commands` while the home is idle and running does not restart the home (`Wants=`, not `Requires=`); `restart_service` and `safe_mode` still work. |
| T-D1 | Astra D (H5) | fixture: start `installing` with an in-memory record naming slot B, then flip `current` to B underneath (simulating a stale drive); the wipe is `Stuck`, `rmtree` is never called, `+i` on the releases dir is never lifted. Also: two concurrent `drive_update` (poll + `--recover-update`): the second raises `Pending` on the lock. |
| T-D2 | sec. 4 seal | after `installing`, every inode in the idle slot has `+i`; `wipe_slot` lifts them all and removes the tree. |
| T-L1' | sec. 7 launchers | build test: the three launchers and `murage-home-launch` are regular files, root 0755, `+i`, inode-identical to what `install-launchers.install` wrote; `murage-turn-launch` refuses when run from a copy (self-inode check). |
| T-L2' | ABI | fixture: a v3 manifest with `launcherAbi` != trust -> `failed/launcher_abi_mismatch`, no download; equal -> proceeds. A v2 manifest -> refused (fixed reason). |
| T-S1 | point 3 | fixture: `current -> B`, `installed.slot == A`, **`inflight == null`** [A1]: `recovery_pending` True, every blocked kind refused, `drive_update` `Stuck(home_layout_mismatch)`, launcher seam 79 `home_layout_mismatch`; [A1] with the home unit simulated active, the call log shows `systemctl stop murage-home.service murage-turns.slice murage-browsers.slice` issued by the updater and the unit inactive afterwards. Repeat with `inflight.phase in {installing, installed}`: same result. |
| [A1] T-S2 | A1 (post-flip boot reaches verify) | fixture: journal `inflight = {slot: B, phase: verify, verifyAttempts: 0}`, `installed.slot == A`, `current -> B`, inhibit present, `/run` empty (boot). Launcher seam: `layout_ok` passes, both slots walked, gate contacted, 79 `gate_denied`. Updater `drive_update`: **no Stuck**; `verifyAttempts` 0 -> 1, grant for B, `systemctl start`, `wait_healthy` probes B; healthy -> commit (`installed = B`, `inflight = null`), inhibit lifted after the commit write. Variant `phase: flip` with `current -> A` (rename not landed): flip handler completes the rename, then the same verify path. Variant unhealthy: `phase = rollback`, `systemctl stop` logged, flip back to A, counted start of A. |
| [A1] T-S3 | A1 (corruption still Stucks) | fixture, each a separate case, all with `inflight.phase == verify`: (a) `current -> B` but `inflight.slot == A == installed.slot`; (b) `current -> A` (not the candidate) during `verify`; (c) `manifests/B.sig` corrupted; (d) one file in slot A lacking `+i`; (e) `installed.sequence != signed(A).sequence`; (f) `current` a dangling link. Every case: launcher 79 `home_layout_mismatch` (or `slot_seal_failed` for d), `drive_update` `Stuck`, `systemctl stop murage-home.service` in the call log, no `systemctl start`, no rename, no grant issued. |
| [A1] T-S4 | A1 (one predicate) | build test: the `layout_ok` source text in `murage-home-launch.py` and in `murage-commands` is byte-identical (same mechanism as the `tree_digest` trusted-copy check). |
| [A1] T-W1 | A1 (explicit stop) | fixture, home simulated active throughout: entering `rollback` from `verify` logs `systemctl stop murage-home.service ...` **before** `phase = rollback` is acted on (before any `symlink`/`rename` of `current`); resuming at `rollback(restored=false)` after a simulated updater restart logs the stop again; `rollbackAttempts == 3` unhealthy -> `Stuck` and the stop is logged; T-G5 still holds (idle home, `systemctl restart murage-commands`, no stop and no restart of the home). |
| T-H4a/b | kept | r2's forged-commit and no-self-report tests unchanged (the structural guarantee is still wanted when root is an operator). |
| T-M | retained | r1/r2 suites unchanged. |

## 9. Honesty: residuals, costs, what would trigger the fallback

- **Achievable: YES.** Every uid-0 exec of slot bytes in the current tree is one of two: the pre-`setuid` supervisor (replaced by the
  image launcher) and the slot-linked launchers (image-pinned). The turn launcher already drops before every exec of slot code
  (`:1334`, `:1804`, namespace `:720`); the freeze and the mounts stay where they are, in image code. No engine needs root from the
  slot. Nothing in the turn protocol changes.
- **Residual 1 (scope, not security): launcher and root-prelude changes need a re-image.** Enforced by `launcherAbi`. Historical
  rate of launcher changes is high during development; after launch, a launcher change is a re-image event. This is the price of
  "no slot byte as root" and is stated as such.
- **Residual 2 (engineering risk): the TS->Python port of `bindHomeVolume`/`prepareEngineHomes`/`prepareBrokerDir`.** Bounded by T-P5
  (tree diff) and by keeping the TS as the executable spec.
- **Residual 3 (unchanged trust boundary):** the image root launchers still parse hostile input from the slot server (turn plans,
  gate requests). That boundary exists today and is already hardened; r3 neither widens nor narrows it. A launcher bug is a
  re-image fix, as today.
- **Residual 4 (signed adversary):** a *signed* malicious release runs as `murage` with the server's reach (customer data) and can
  make itself unhealthy (rollback, counted, then Stuck at worst). It can no longer touch the other slot, the journal, the trust
  root, or boot itself unverified. The signing key remains the trust root; that is by definition.
- **Residual 5 (cost):** full-tree hash at each home start (seconds); two resident slots (as r2). [A1] Starts inside
  `flip`/`verify`/`rollback` hash both slots; at most 2 + 3 such starts per update (the counters), so the added cost is bounded.
- **Fallback trigger (none hit):** the design would be BLOCKED only if a slot component needed uid 0 (none does) or if the freeze
  could not stay in image code (it can - the file simply stops being a symlink). Neither holds, so the recommendation is SHIP.

## Amendment A1 (Grok r3 review): phase-aware layout predicate

**Status:** patch to r3, 2026-10-24. Grok confirmed every other part of r3 (including `Wants=`, not `Requires=`/`BindsTo=`, for
`murage-home.service -> murage-commands.service`) and raised ONE High. Everything in this section is self-contained; the inline
`[A1]` marks above are the rows this section makes true. Grounded in `fix/cloud-lane-g-update-software` @ f7713e0cb.

### A1.1 The High, restated against the code

r3 sec. 1.4 step 5 and sec. 4 drive entry both required `readlink(current) == installed.slot`. But the flip (`symlink` +
`rename` of `current`, r2 sec. 4 row `flip`) moves `current` to `inflight.slot` while `installed` keeps naming the committed slot
until the single commit write (`installed := new, inflight := null`). So for the whole `flip -> verify -> (rollback)` span the two
disagree **by design**. With the r3 rule, the verify start exited 79 `home_layout_mismatch` before the gate, the updater Stucked
at drive entry before its `verify` handler, the candidate was never health-checked, rollback was never reached, and after a power
loss or a `murage-commands` restart (`Restart=always`, `murage-commands.service:20`) the unverified tree stayed live as `current`
across boot with nothing driving it forward or back. Today's code shows the same span: `update_journal(... "swap")` :760 ->
`os.rename(staging, opt)` :772 -> `update_journal(... "verify")` :778 -> `start_home` :780, with the journal's notion of the installed
release only updated by `commit_update` :825-829.

### A1.2 The predicate, `layout_ok(state, S)` (one function, identical in both seams)

Inputs: `state` (strict v3 shape, else fail), `S = readlink(/opt/murage-releases/current)` (must be `A` or `B`, read through the
`O_PATH|O_NOFOLLOW` fd of sec. 1.4 step 1, else fail). `I = installed.slot`, `C = inflight.slot` when `inflight` is present.
`man(X)` = the signed manifest of slot `X` (`/var/lib/murage-update/manifests/X.json` + `.sig`, verified against the trust key, sec.
1.4 step 4); `sealed(X)` = the seal walk of slot `X` through its own dirfd with `tree_digest == man(X).treeSha256` (sec. 1.4 step 3).

| Group | `inflight` | `S` must be | Per-slot requirements | On failure |
|---|---|---|---|---|
| committed (today's rule) | `null`, or `phase in {installing, installed}` | `== I` | `sealed(I)`, `man(I).sequence == installed.sequence` | fail |
| transition | `phase == flip` | `in {I, C}` | `C != I`; `sealed(I)` and `man(I).sequence == installed.sequence`; `sealed(C)` and `man(C).sequence == inflight.sequence`, `man(C).revision == inflight.revision`, `man(C).launcherAbi == trust.launcherAbi`, `man(C).sequence` passes the sec. 2 floor against `man(I)` | fail |
| transition | `phase == verify` | `== C` (the `verify` record is written only after `readlink(current) == slot` succeeded, r2 sec. 4 `flip` row) | same as `flip` | fail |
| transition | `phase == rollback, restored == false` | `in {I, C}` (the flip-back rename may have landed before the `restored = true` write) | same as `flip` | fail |
| transition | `phase == rollback, restored == true` | `== I` | same as `flip` | fail |
| other | unreadable, wrong shape, unknown phase, `S` not in `{A, B}` | - | - | fail |

"fail" is one outcome: the launcher exits 79 with reason `home_layout_mismatch` (`slot_seal_failed` when the failing check is a
seal walk, so operators can tell corruption from a moved link); the updater raises `Stuck(home_layout_mismatch)` (same split), and
**the `Stuck` handler stops the home first** (A1.3). Nothing in the journal is changed by a failure, as before.

Why both slots in the transition group: the committed slot is what rollback will flip back to, so it must be provably intact
before the design relies on it; the candidate is what verify is about to start, so it must carry the updater's own signed manifest
(written in `installing`) before any grant can start it. This is the same signature-gated rule r3 already applied to rollback
(sec. 4 `rollback, restored=false`), now applied at every entry of the span, by the launcher as well as the updater.

What the predicate does NOT decide: whether to start. In the transition group it hands over to the sec. 3 gate unchanged, which
requests a grant for `S`. The updater's grant names the slot it is driving (`C` in verify, `I` in rollback), so a start of the
wrong slot inside the span is still `deny` -> 79, and an ungranted start (boot, `Restart=`) is still `deny` -> 79.

### A1.3 The explicit stop: where it is issued and by whom

`Wants=` (confirmed by Grok, kept) orders and pulls in `murage-commands.service` but never stops `murage-home.service`, and
`Requires=` would restart every customer home on every updater restart. So the home is stopped explicitly, by the **updater**
(`murage-commands`, image root code), through the existing `stop_writers(ctx)` (`murage-commands:991-999`): inhibit written and
fsync'd first (`inhibit_starts` :964-970), then `systemctl stop murage-home.service murage-turns.slice murage-browsers.slice`
(`WRITERS` :954), then up to 60 s confirming every unit is `inactive`/`failed`. Two sites, both in `murage-commands`:

1. **On Stuck.** `drive_update` gets one wrapper: `except Stuck: stop_writers(ctx); raise`. Every `Stuck` the design names (trust
   root invalid, journal invalid, `layout_ok` failed, wipe-target re-derivation failed, rollback gate failed, `rollbackAttempts == 3`)
   passes through it. It runs again on every poll while Stuck (idempotent; a stop of an inactive unit returns 0), so a home an
   operator starts by hand while the box is Stuck is taken down on the next poll, which is the intended meaning of Stuck.
   `recovery_pending` (a query used by `start_home` and the blocked-kinds check) runs the same predicate but never stops anything;
   the stop belongs to the driver.
2. **On entering rollback.** The `verify` handler writes `phase = rollback` and then calls `stop_writers(ctx)` before anything
   else (today's `rollback_update` already does this at :834-836; r3 keeps it and the `restored=false` handler calls it again on
   every resume, so a flip-back rename never happens under a running candidate, in line with sec. 1.4's "the flip happens only
   while the home is stopped").

The launcher (`murage-home-launch`) never issues a stop: it is the process being started, and exit 79 with
`RestartPreventExitStatus=78 79` already ends that start. The two sites above are the only ones.

### A1.4 Re-verification: no r3 sec. 6 High reopens

| Finding | Why A1 leaves it closed |
|---|---|
| Candidate running as uid 0 (sec. 1, G-H4.1, G-H4.2) | The predicate changes which slot is verified, not how it is executed. The drop (sec. 1.4 step 7, `setuid(murage)` verified by `getuid()==geteuid()`) and the `exec_slot` guard (sec. 1.3) precede every exec of slot bytes in every phase; the supervisor asserts `getuid() !== 0` at entry (sec. 1.2). |
| Candidate boots unverified without a counted grant (G-H4.4, A-D H6) | The predicate runs BEFORE the gate and never replaces it. In `verify` the launcher still connects and still needs a live grant; at boot and on `Restart=` there is none -> 79 `gate_denied`. Every grant is preceded by `verifyAttempts += 1` / `rollbackAttempts += 1`. A1 adds no start path; it removes a false Stuck that prevented the counted path from running. "Unverified" after A1 means "not yet health-checked", never "not signature-checked": the candidate must pass `sealed(C)` and `man(C)` before the gate is even consulted. |
| Genuine layout corruption (G-H4.3, T-S1) | Still Stuck: `S` outside the phase's allowed set; `S == C` with no in-flight record; `C == I`; either slot failing its own seal or signed manifest; `installed.sequence` disagreeing with `man(I)`; a dangling or non-`{A,B}` link. And now the home is stopped explicitly on that Stuck. The only newly tolerated shape is `S == C` while a real in-flight record in `flip`/`verify`/`rollback` names `C`, with both slots signature-verified. |
| Forged journal admits the tolerated shape (A-A, G-H4.3) | No writer of `state.json` exists in the home unit (0700 root, `ReadOnlyPaths=/var/lib/murage-update`, no root slot code). Even an operator-forged `inflight = {phase: verify, slot: C}` buys only a candidate that must already carry a manifest signed by the release key with a sequence above the signed floor, and a start that still needs the live grant. |
| Stale-drive wipe (A-D H5) | Untouched: the wipe lives in `installing`, which is in the committed group (`S == I` required), and the wipe-time re-derivation plus inode inequality (sec. 4) stand. |
| systemd-run / TOCTOU (A-B), unsigned slot A (A-C) | Untouched: no uid change, no new exec, and A1 adds signature checks (both slots), removes none. |
| Availability (T-G5) | `Wants=` kept; the stop is issued only on Stuck and at rollback entry, never on an updater restart with an idle home. |

### A1.5 Tests changed or added by A1 (all in sec. 8 above)

- Changed: **T-S1** (now explicitly `inflight == null` / pre-flip phases, and asserts the explicit stop), **T-G2** (post-flip layout;
  every ungranted 79 is `gate_denied`; the candidate is probed; stop logged at rollback entry), **T-G4** (every allowed `current`
  per phase; reason tokens; two seal walks in transition cells).
- Added: **T-S2** (post-flip, pre-commit boot reaches verify and health-checks the candidate; `flip` variant with the rename not
  landed; unhealthy variant rolls back), **T-S3** (six corruption shapes inside `verify` all Stuck + stop, no start, no rename,
  no grant), **T-S4** (`layout_ok` byte-identical in both seams), **T-W1** (the explicit stop at rollback entry precedes any rename,
  repeats on resume, fires on `rollbackAttempts == 3`, and T-G5 still holds).

### A1.6 Per-file delta summary for A1 only

- `deploy/cloud-home/murage-home-launch.py`: `check_journal(slot)` -> `layout_ok(state, slot)`; `open_live_slot()` gains
  `open_slot(name)` so the second slot is walked through its own dirfd; the stderr reason tokens of sec. 3.
- `deploy/cloud-home/murage-commands`: `layout_ok` (same text); `drive_update` `except Stuck: stop_writers(ctx); raise`;
  `verify` handler calls `stop_writers(ctx)` right after writing `phase = rollback`; the `rollback(restored=false)` handler calls it
  on every entry. No unit file changes; no change to the sudoers line, the trust root, the gate protocol or the counters.

LANE-G-R3-A1=DONE
