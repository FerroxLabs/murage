// Every recursive delete in the repository goes through safe-wipe, or is
// listed here with a reason. docs/verification/data-safety.md is the audit
// this test keeps true; the 2026-09-11 21:05 incident is why it exists.
//
// A stale allowlist entry (file no longer contains a recursive delete) fails
// too, so the list can only shrink honestly.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { VITEST_INCLUDE } from "./test-file-scope.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SCANNED = /\.(?:ts|tsx|mjs|cjs|js|sh|yml|yaml|ps1|nsh|nsi|py)$/;
const SKIPPED_PREFIX = ["node_modules/", "electron/vendor/", "docs/"];
/** JS/TS recursive delete calls, one line at a time. */
const JS_DELETE = /\b(?:rmSync|rm|rmdirSync|rmdir|rimraf)\s*\((?![^)]*\bmkdir)[^;]*?\brecursive\s*:\s*true|\brimraf\s*\(/;
/** Shell-shaped recursive deletes anywhere (scripts, workflows, strings). */
const SHELL_DELETE = /\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\b|\brm\s+-[a-zA-Z]*[rR]\b/;
const NOT_A_DELETE = /\b(?:mkdirSync|mkdir|readdirSync|readdir|cpSync|cp|copySync)\s*\(/;

/**
 * Files that still contain a recursive delete on purpose. Each entry names
 * the file and why the delete cannot reach a Murage data directory. Add an
 * entry only with a reason a reviewer can check against the file.
 */
const ALLOWLIST: Record<string, string> = {
  "server/testing/safe-wipe.mjs": "the helper itself: rmSync/rm run only after assertSafeToWipe admits the path",
  "server/testing/cleanup.ts": "removeTempDir calls assertSafeToWipe before its rmSync retry loop",
  "server/browser-sandbox-linux-engine.ts": "LINUX_ENGINE_ENABLE_SCRIPT, run as root by the Linux Enable browser step (27fd46da6), removes only its own staging copy, its .copy-* leftovers and superseded Chrome version folders under the fixed root-owned LINUX_ENGINE_ROOT; never a data directory, and safe-wipe would refuse a path outside temp",
  "scripts/check-addon-msvc-headers.sh": "a POSIX sh dev check (dc5f1f10c): rm -rf only of the mktemp -d object folder it made at the top; scripts/safe-wipe.sh is Bash and cannot be sourced from sh",
  "server/testing/link-removal.fixture.cjs": "run only by link-removal.electron.test.ts on paths inside the mkdtemp folder it is given (argv[3]): it records what the runtime's own rmSync does to a junction there",
  "server/testing/link-removal-native.fixture.cjs": "run only by link-removal.native.test.ts on paths inside the mkdtemp folder it is given (argv[4]): its rmSync calls go through the installed handle-based remove, on a tree it made there",
  "scripts/scale/hz-vitest.sh": "cleanup() runs `rm -rf -- \"${dir:?}\"` on the build host rig over ssh (never on this machine): dir is $H/vitest-<label> under the rig's own scratch root, set non-empty by ${dir:?}, and holds only the git-archive copy the same script just made",
  "scripts/safe-wipe.sh": "the shell helper itself: rm -rf runs only after the same checks pass",
  "server/backup-restic.ts": "0607 (07-A4/07-A5): each rmSync removes a folder this file made with mkdtempSync under options.workDirectory (restore-*, the upload stage); the stored prior.stage is removed only after the pathWithin(realpath(workDirectory)) check at its read",
  "electron/backup-remote-export.mjs": "0607 4c835e83b discardDownloadedCopy: removes only a restore-* folder whose realpath is inside the host's own work root (both checked on the line itself)",
  "server/testing/index-harness.ts": "'rm -rf /tmp/…' are card subtitles in fixture messages the index suites seed; nothing executes them, and teardown uses removeTempDir",
  "server/testing/fake-codex-app-server.ts": "'rm -rf scratch' is a string the fake engine sends as an approval request; nothing executes it",
  "installer/test/systemd.test.mjs": "asserts the exact `rm -r <staging dir>` text setup prints for the operator; the file's own fixture teardown uses safeWipeSync",
  "server/container-computer.ts": "rm -rf \"$source\" inside a generated shell script that runs in the sandbox container against its own copy",
  "server/box-exec.ts": "computer_exec's box-side shell, sent to the bot's cloud box and run there (never on this machine): every rm -rf is `rm -rf -- \"${J:?}\"` on one job record under $HOME/.cache/murage-exec/<id>, the id checked against [a-f0-9]{16,64} (jobDir) or re-checked before the sweep removes it",
  "installer/lib/systemd.mjs": "prints `rm -r <mkdtemp staging dir>` for the operator to run by hand after the unit is installed; not executed here",
  "installer/lib/tailscale.mjs": "shredAuthKeyFile removes the private mkdtemp directory it created for the auth key",
  "electron/backup-remote-runtime.mjs": "forgetRemoteWorkDirectory removes <control>/remote/<ref> only: the ref is checked against the reference pattern, the path is rebuilt from the control root (never a caller path), must be a direct child of <control>/remote, and must be a real owner-owned directory (no symlink) before the delete",
  "server/tts/windows-voices.ts": "the finally clause removes the `murage-say-` mkdtemp directory opened three lines above in the same function; `dir` is never reassigned and never comes from config, a bot or a request",
  ".github/workflows/package-win.yml": "rm -rf dist dist-server release: build outputs on an ephemeral CI runner",
  ".github/workflows/release.yml": "rm -rf dist dist-server dist-native release: build outputs on an ephemeral CI runner",
  ".github/workflows/package-mac-qualification.yml": "rm -rf dist dist-server dist-native release: build outputs on an ephemeral CI runner",
  "scripts/b22-linux-pilot.mjs": "prints (never runs) the pilot VM cleanup command, which re-checks both roots are not links and carry this pilot's owner marker before `rm -rf --one-file-system`",
  "scripts/b22-linux-pilot.node-test.mjs": "asserts the printed plan omits `rm -rf` when removeData is false; the file's own fixture teardown uses safeWipeSync",
  "scripts/prepare-backup-age.mjs": "build-only: removes the mkdtemp download/extract scratch under os.tmpdir()",
  "scripts/prepare-windows-backup-tools.mjs": "build-only: removes the mkdtemp download/extract scratch under os.tmpdir()",
  // Murage for Chrome tests and proof scripts (lane chrome): each removes
  // only the mkdtemp fixture root, profile or output folder it created.
  "electron/browser-extension-host.node-test.mjs": "the finally clause removes the test's own mkdtemp root",
  "electron/browser-extension-registration.node-test.mjs": "the finally clause removes the test's own mkdtemp root",
  "electron/model-signin.node-test.mjs": "the finally clause removes the fake HOME the test made with mkdtempSync(tmpdir(), \"murage-signin-home-\") and restores the real HOME first",
  "scripts/browser-extension-host-registration.node-test.mjs": "each finally clause removes that test's own mkdtemp root",
  "scripts/prepare-browser-extension.node-test.mjs": "each finally clause removes that test's own mkdtemp output or scratch directory",
  "scripts/prove-browser-extension-approval.mjs": "removes the browser profile inside its own mkdtemp run folder",
  "scripts/prove-browser-extension-native.mjs": "removes the mkdtemp profile, fixture home, temp and state folders it created",
  "scripts/prove-browser-extension-phone.mjs": "removes its own mkdtemp companion registry folder",
  "scripts/prove-browser-extension.mjs": "removes the mkdtemp browser profile it created",
  // apps/mobile is its own package (no dependency on server/ or scripts/).
  // Every recursive delete a Mac-side apps/mobile script makes now routes
  // through scripts/safe-wipe.sh (build-web-dist.sh, door.sh, run-host.sh,
  // stop-host.sh, android-e2e.sh, ios-e2e.sh). The two entries below are the
  // ones the preferred fix does not fit, same as data-safety.md documents
  // for a remote-host command or a test that owns its temp dir.
  "apps/mobile/scripts/android-remote.sh": "rm -rf runs inside an ssh command string on build-host, never on this machine: only $QLANE/gradle-home and fixed build-output subdirectories of the build host build lane /root/mb-mobile/plan3b, never a Murage data directory",
  "apps/mobile/src/android-cap-path.test.ts": "line 37's afterEach removes only the mkdtempSync(os.tmpdir(), 'mm-cap-path-') roots this file itself created and tracked in `dirs`; line 51 is a test-data string ('a semicolon' case) asserting cap_path REJECTS an injected `rm -rf`, not a delete that runs",
  "apps/mobile/src/e2e-host-safety.test.ts": "every rmSync is this file's own fixture teardown: root/outside are mkdtempSync(os.tmpdir(), ...) directories the test created, data is the mkdtempSync('/tmp/murage-e2e-data-test-') directory hostEnv() created, and host.lock is the mkdirSync(file(\"host.lock\")) this test made under its own copied `host` tree",
  // Production runtime. These delete paths the app itself owns (mkdtemp
  // scratch, staging, per-skill or per-bot subdirectories under DATA_DIR)
  // and are covered by their own unit tests; routing the app through a test
  // helper would be the wrong layer. None deletes DATA_DIR or a parent of it.
  "electron/backup-windows-acl.mjs": "removes its own mkdtemp temp folder holding the icacls /save listing of the backup folder's ACL",
  "electron/cua-linux-bundle.cjs": "removes the mkdtemp stage and the previous bundle directory under the app's own resources root",
  "electron/skill-recorder.mjs": "removes the mkdtemp session directory under app.getPath('temp')",
  "electron/skill-recording-store.mjs": "removes its own temporary skill directory when the publish rename fails",
  "electron/speech.mjs": "removes the mkdtemp session directory under app.getPath('temp')",
  "server/bot-package-archive.ts": "removes the mkdtemp scratch beside the archive it is writing",
  "server/bot-package-import.ts": "removes the import staging directory it created",
  "server/skill-collection.ts": "removes its own .incoming-<uuid> import staging and .replaced-<uuid> copy under DATA_DIR/skill-collection, and a deleted skill's DATA_DIR/skill-collection/<name> after isSkillName (no dots or slashes)",
  "server/drivers/claude.ts": "removes the per-session mkdtemp MCP config directory",
  "server/browser-sandbox.ts": "removes its own mkdtemp murage-browser-acl-* folder holding the icacls /save listing (Windows), and the mkdtemp murage-sandbox-probe-* Chrome profile only after checking it sits directly in tmpdir() with that prefix (Linux)",
  "server/drivers/pi.ts": "removes the per-session mkdtemp MCP config directory",
  "server/engine-management.ts": "removes the mkdtemp scratch of an engine install probe",
  "server/fuigo-native-update.ts": "removes the mkdtemp probe home and download directory",
  "server/index.ts": "removes the mkdtemp scratch of a selected-conversation export",
  "server/engine-fs.ts": "the mutOps.removeTree member is the one recursive delete of the engine-history executor: engine-exec.ts calls it only through removeConfined, for a deleted conversation's folders strictly inside a known root and reached without a symlink; never a root itself",
  "server/installation-archive.ts": "removes the mkdtemp write scratch and inspection stage of a backup archive",
  "server/installation-damaged-export.ts": "removes the mkdtemp scratch of a damaged-installation export",
  "server/installation-database-snapshot.ts": "removes the mkdtemp scratch beside the snapshot target",
  "server/installation-memory-downgrade.ts": "removeDataDirNamesAfter102 removes only the folders named in DATA_DIR_NAMES_AFTER_102 (env/, the kept login-shell environment, claude-private/, a Claude turn's settings overlays, and the file claude-signin-answers.json) directly inside the data folder Prepare to reinstall was given, after lstatSync shows each is a real directory (a link is unlinked, never followed); never the data folder itself; production code does not import the wipe helper of the test tree",
  "server/backup-local-work.ts": "removes only run-<pid>-XXXXXX folders it made under its own .murage-backup-work/<hash> root (sweep matches the run-name pattern; removeBackupWork refuses any other path); never the data folder",
  "server/installation-encrypted-backup.ts": "removes its own mkdtemp .murage-encrypted-write-*/.murage-encrypted-inspection-* scratch, stage and .recovery-* directories (retained when a tool close is unconfirmed); never the installation root",
  "server/installation-recovery-command.ts": "removes the mkdtemp scratch of backup inspect / restore plan commands",
  "server/installation-restore-preparation.ts": "removes the inspected archive directory it extracted when preparation fails",
  "server/installation-restore.ts": "removes an unpublished restore candidate and its inspection directory; never the installation root",
  "server/installation-state-snapshot.ts": "removes the unpublished snapshot stage",
  "server/package-import-transaction.ts": "removes the import transaction directory and empty parents it created",
  "server/memory/evolution-forgetting.ts": "removes only DATA_DIR/learning-local/<bot> after the bot id passes SAFE_SEGMENT (no dots or slashes) for \"forget this learning data\", and corpus* temporary folders directly inside a SAFE_SEGMENT bot folder there after a day; never learning-local itself, DATA_DIR or a parent",
  "server/provider-routing.ts": "cleanup of the mkdtemp provider home a routing probe created",
  "server/skills.ts": "removes skill directories, legacy links and staging under DATA_DIR/skills that the store owns",
  "server/store.ts": "removes a deleted bot's workspace and skill-state subdirectories under DATA_DIR",
  "electron/compile-cache.mjs": "pruneStaleCaches removes sibling cache directories of other app versions inside the app's own <userData>/compile-cache root, never the kept one or the root itself",
  "server/channels/whatsapp/core/auth-store.ts": "wipeAuthDir removes the children of the WhatsApp auth directory after lstat proves it is a real directory (a symlinked directory is refused); never the directory itself or a parent",
  "server/channels/whatsapp/wipe.ts": "removes only the fixed WhatsApp paths of one connection (whatsapp/auth, whatsapp/media/<id>, <id>.-prefixed journals, channels/whatsapp/<id>) under DATA_DIR after assertInside rejects any escape or symlink ancestor; the connection id matches [a-zA-Z0-9-]{1,100}; never DATA_DIR or a parent",
  "server/drivers/turn-credentials.ts": "dispose removes the murage-cred- mkdtemp directory createTurnCredentialStore made, held in a const never reassigned",
  "server/fuigo-turn-logs.ts": "removes <home>/logs of a finished turn (a symlink is unlinked, never followed) and kept turn-log directories directly inside the turn-log root it owns; never the home or the root",
  "server/memory/pip-transport.ts": "removeTempRoot refuses any path that is not strictly inside the reflection temp base, then removes that one run directory",
  "apps/mobile/e2e/freshauth/run.mjs": "cleanup removes only the realpath'd mkdtempSync(tmpdir(), 'murage-p7-') root this run made, and only when it is still under tmpdir; apps/mobile has no dependency on server/testing",
  // Reviewed for the engine-deletion lane (each checked against its file, 2026-10-11).
  "scripts/scale/hz-scale.sh": "the rm -rf is inside the ssh command string and runs on build-host, never on this machine: it empties the children of $H/scale-$label/src, where $H is the fixed /root/mb-0161-hz and $label passed ^[a-z0-9-]+$ above; the tree is exported again straight after",
  "scripts/scale/run-container.sh": "runs inside the scale-rig container only: every rm is `rm -rf -- \"${VAR:?}\"` on the container's own /scale/data/murage mount or its /scale/cache/<key> cache folder, rebuilt from the fixed /scale/cache root and a key made of the run's shape, seed and tree names plus a short hash of the generator, so some of its parts come from the run's environment; the root is fixed and the name is a single path segment",
  "server/connector-cache-harness.ts": "usableToolsCacheDir removes once the connector tools-cache folder (CONNECTOR_TOOLS_CACHE_DIR, a folder Murage made for itself) when Windows privacy checks refuse it; everything in it can be fetched again, and it is made again at once",
  "server/drivers/acp/core.ts": "the process-exit handler removes the murage-mcp-listed- mkdtemp folder (one private marker directory per Murage process) opened a few lines above; `root` is a const copy of it, production code does not import the test-only safe-wipe",
  "server/drivers/murage-exec.ts": "privateDir's process-exit handler removes the murage-exec- mkdtemp folder (0700, one per Murage process) made on the line above; `dir` is a const copy of it, never a data directory; production code does not import the test-only safe-wipe, and on Windows the process-wide rmSync from link-removal.ts takes the remove",
  "server/always-ask.ts": "the Always ask command classifier: line 518 is the regex /^rimraf(@\\S*)?$/ that spots a rimraf runner, and the `rm -rf` hits are /** doc comments describing commands it classifies; nothing here deletes",
  "server/auto-approve.ts": "the auto-approve classifier: the `rm -r`/`rm -f` hit is the opening /** line of the doc comment on the Remove-Item reading (1.0.4 F1); it deletes nothing",
  "server/shell/walk.ts": "the shell command walker the Always ask classifier reads: the `rm -rf` hits are /** doc comments describing commands it parses; nothing here deletes",
  "server/drivers/acp/grok.ts": "the process-exit handler removes the murage-grok-isolation- mkdtemp folder opened a few lines above; `dir` is a const copy of it",
  "server/drivers/antigravity-scope.ts": "every delete is inside a scoped Antigravity home Murage built itself (its own links and reconciled copies, never followed), a lock folder it made, or a moveInto source it just copied; none can be DATA_DIR or the owner's real engine home",
  "server/drivers/scoped-cli-home.ts": "every delete is inside a per-engine scoped home Murage made (a cache folder the marker names as one segment and lstat shows is a real directory, its own temporary generation, a retired scope after its logins were set aside, or a pruned cache entry); the owner's real engine home is only ever linked into it and never removed",
  "server/memory/revocation-index.bench.mjs": "benchmark run by hand: the finally clause removes the revoke-bench- mkdtemp folder it made",
  "server/memory/testing/perf-fixture.ts": "fixture helper imported only by vitest suites: DATA_DIR resolves under the temporary HOME server/testing/setup.ts makes (setup deletes any MURAGE_DATA_DIR override before anything loads) and installSafeWipeGuard protects it (it refuses the real ~/.murage); the cache folder is the MEMORY_PERF_CACHE the run set",
  "server/memory/testing/recall-fixture.ts": "fixture helper imported only by vitest suites: DATA_DIR resolves under the temporary HOME server/testing/setup.ts makes (setup deletes any MURAGE_DATA_DIR override), behind the same runtime guard",
  "server/tts/system-voices.ts": "removes the mkdtemp directory a voice probe created",
  // Cloud home image and its qualification. These run as root on a disposable
  // image builder or test host (never a Mac, never a customer home with data).
  "deploy/cloud-home/build-image.sh": "runs only as root on the Ubuntu image builder (refuses any other host at the top): removes snapd's own directories after its purge, the builder's logs before the snapshot, and its /tmp/murage-image.* stage in an EXIT trap that re-checks that prefix first",
  "deploy/cloud-home/qualify/negative-tests.sh": "runs as root on the Cloud home VM under qualification (refuses a non-root run at the top): qm_clean removes only the qualification bot's own workspace, after a fixed-prefix check (/data/home/workspaces/qualbot-NNNN, the literal QUAL_BOT set in the file), a symlink refusal and `rm -rf -- \"${WS:?}\"`",
  "deploy/cloud-home/qualify/backup-restore-test.sh": "the disposable-host guard at its entry point (server/cloud-home/backup-restore-guard.test.ts) exits before any delete unless /etc/mcq-disposable-test-host, which only backup-restore-test-hcloud.sh writes on the VM it just created, is present, and refuses any host with /etc/murage-home/enrolled, /etc/murage-home/identity.json or /data/home; only then does it reset its own fixed fixture paths /root/bk-test, /data, /srv/bk-repo and /restore and empty its own restic repository for the retention check",
  "deploy/cloud-home/qualify/hz-live.py": "the rm -rf is inside a command string sent over ssh to the image builder VM before its snapshot (fixed builder paths: /build, root's dotfiles, host keys, journal), never run on this machine",
  "server/cloud-home/home-commands.fixture.py": "'customer; rm -rf /' is a reason string the fixture submits to prove the home command queue refuses it; nothing executes it",
  "server/cloud-home/own-server.ts": "removeConnection deletes only <data dir>/own-server/bin, the fixed wrapper folder writeWrapper made; the path is rebuilt from the data dir, never from a caller or request, and never the data dir itself",
};

// VITEST_INCLUDE (the files that run under server/testing/setup.ts and its installSafeWipeGuard) lives in test-file-scope.ts,
// where temp-cleanup-guard.test.ts reads the same list.

/** The tracked files. With no .git (a copy made for a container run) the listing saved beside this test is read instead:
 * `git ls-files -z > server/testing/.git-ls-files.fixture` in a checkout makes it. It is never committed. */
const tracked = (): string[] => {
  let listing: string;
  try {
    listing = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    listing = readFileSync(join(ROOT, "server/testing/.git-ls-files.fixture"), "utf8");
  }
  return listing.split("\0").filter(Boolean);
};

/** A JS/TS recursive delete whose options object spans lines. */
const JS_DELETE_MULTILINE = /\b(?:rmSync|rm|rmdirSync|rmdir)\s*\((?:[^;()]|\([^;()]*\))*?\brecursive\s*:\s*true/g;

const findDeletes = (file: string): string[] => {
  const hits: string[] = [];
  const text = readFileSync(join(ROOT, file), "utf8");
  const shellLike = /\.(?:sh|yml|yaml|ps1|nsh|nsi|py)$/.test(file);
  const lines = text.split("\n");
  const isComment = (line: string) => { const t = line.trim(); return t.startsWith("//") || t.startsWith("*") || t.startsWith("#"); };
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (isComment(line)) return;
    if (NOT_A_DELETE.test(line) && !/\b(?:rmSync|rm|rmdirSync|rmdir|rimraf)\s*\(/.test(line)) return;
    if (JS_DELETE.test(line) || (shellLike && SHELL_DELETE.test(line)) || (!shellLike && /["'`][^"'`]*\brm\s+-[a-zA-Z]*[rR]/.test(line))) {
      hits.push(`${file}:${index + 1}: ${trimmed.slice(0, 140)}`);
    }
  });
  if (!shellLike) {
    for (const match of text.matchAll(JS_DELETE_MULTILINE)) {
      if (!match[0].includes("\n")) continue; // the per-line pass already has it
      const index = text.slice(0, match.index).split("\n").length - 1;
      if (isComment(lines[index])) continue;
      hits.push(`${file}:${index + 1}: ${match[0].replace(/\s+/g, " ").slice(0, 140)}`);
    }
  }
  return hits;
};

describe("data safety: recursive deletes", () => {
  const files = tracked().filter(f => SCANNED.test(f) && !SKIPPED_PREFIX.some(p => f.startsWith(p)) && f !== "pnpm-lock.yaml");

  it("scans a real tree", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain("server/testing/safe-wipe.mjs");
  });

  it("every recursive delete outside vitest goes through safe-wipe or is allowlisted with a reason", () => {
    const unrouted: string[] = [];
    for (const file of files) {
      if (VITEST_INCLUDE.some(rx => rx.test(file))) continue;
      const hits = findDeletes(file);
      if (!hits.length) continue;
      if (ALLOWLIST[file]) continue;
      unrouted.push(...hits);
    }
    expect(unrouted, "route these through safeWipeSync/safeWipe (server/testing/safe-wipe.mjs) or scripts/safe-wipe.sh, or allowlist them with a reason").toEqual([]);
  });

  it("keeps the allowlist honest: every entry still contains a recursive delete", () => {
    const stale = Object.keys(ALLOWLIST).filter(file => !files.includes(file) || findDeletes(file).length === 0);
    expect(stale).toEqual([]);
  });

  it("human specs and configs read MURAGE_E2E_DATA_DIR only through lane-data-dir.ts, with no fallback", () => {
    const offenders: string[] = [];
    // evidence.test.ts is a vitest test of that contract and sets the variable on purpose.
    for (const file of files.filter(f => f.startsWith("src/e2e/") && f !== "src/e2e/lane-data-dir.ts" && !f.endsWith(".test.ts"))) {
      const text = readFileSync(join(ROOT, file), "utf8");
      text.split("\n").forEach((line, index) => {
        if (/process\.env\.MURAGE_E2E_DATA_DIR/.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders).toEqual([]);
    const helper = readFileSync(join(ROOT, "src/e2e/lane-data-dir.ts"), "utf8");
    expect(helper).not.toMatch(/MURAGE_E2E_DATA_DIR\s*(?:\|\||\?\?)/);
    expect(helper).toMatch(/assertSafeToWipe\(/);
    // evidence.ts (every config's outputDir, which Playwright wipes) resolves
    // its root through lane-data-dir.ts and admits an override the same way.
    const evidence = readFileSync(join(ROOT, "src/e2e/evidence.ts"), "utf8");
    expect(evidence).toMatch(/laneDataDir\(/);
    expect(evidence).toMatch(/assertSafeToWipe\(resolve\(override\)/);
  });

  it("every Playwright outputDir (which Playwright wipes) comes from evidenceDir/evidenceRoot, never a literal path", () => {
    const bad: string[] = [];
    for (const file of files.filter(f => /^src\/e2e\/.*\.config\.ts$/.test(f))) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const match = /outputDir\s*:\s*([^,}]+)/.exec(text);
      if (!match) { bad.push(`${file}: no outputDir`); continue; }
      const expr = match[1].trim();
      const viaEvidence = (source: string) => /\bevidence(?:Dir|Root)\(/.test(source) && !/MURAGE_E2E_DATA_DIR/.test(source) && !/["'`]\.\.\//.test(source);
      if (viaEvidence(expr)) continue;
      if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
        const decl = new RegExp(`const ${expr}\\s*=\\s*([^;]+);`).exec(text)?.[1] ?? "";
        if (viaEvidence(decl)) continue;
        bad.push(`${file}: ${expr} = ${decl.trim()}`);
        continue;
      }
      bad.push(`${file}: outputDir ${expr}`);
    }
    expect(bad).toEqual([]);
  });

  it("the runtime guard is installed for vitest and for node --test", () => {
    expect(readFileSync(join(ROOT, "server/testing/setup.ts"), "utf8")).toMatch(/^installSafeWipeGuard\(\{ protect: /m);
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:electron"]).toContain("--import ./server/testing/safe-wipe-preload.mjs");
    expect(readFileSync(join(ROOT, "server/testing/safe-wipe-preload.mjs"), "utf8")).toMatch(/^installSafeWipeGuard\(\{ protect: /m);
  });
});
