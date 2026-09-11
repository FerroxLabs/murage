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
  "scripts/safe-wipe.sh": "the shell helper itself: rm -rf runs only after the same checks pass",
  "server/testing/fake-codex-app-server.ts": "'rm -rf scratch' is a string the fake engine sends as an approval request; nothing executes it",
  "installer/test/systemd.test.mjs": "asserts the exact `rm -r <staging dir>` text setup prints for the operator; the file's own fixture teardown uses safeWipeSync",
  "server/container-computer.ts": "rm -rf \"$source\" inside a generated shell script that runs in the sandbox container against its own copy",
  "installer/lib/systemd.mjs": "prints `rm -r <mkdtemp staging dir>` for the operator to run by hand after the unit is installed; not executed here",
  "installer/lib/tailscale.mjs": "shredAuthKeyFile removes the private mkdtemp directory it created for the auth key",
  ".github/workflows/package-win.yml": "rm -rf dist dist-server release: build outputs on an ephemeral CI runner",
  ".github/workflows/release.yml": "rm -rf dist dist-server dist-native release: build outputs on an ephemeral CI runner",
  // Production runtime. These delete paths the app itself owns (mkdtemp
  // scratch, staging, per-skill or per-bot subdirectories under DATA_DIR)
  // and are covered by their own unit tests; routing the app through a test
  // helper would be the wrong layer. None deletes DATA_DIR or a parent of it.
  "electron/cua-linux-bundle.cjs": "removes the mkdtemp stage and the previous bundle directory under the app's own resources root",
  "electron/skill-recorder.mjs": "removes the mkdtemp session directory under app.getPath('temp')",
  "electron/skill-recording-store.mjs": "removes its own temporary skill directory when the publish rename fails",
  "electron/speech.mjs": "removes the mkdtemp session directory under app.getPath('temp')",
  "server/bot-package-archive.ts": "removes the mkdtemp scratch beside the archive it is writing",
  "server/bot-package-import.ts": "removes the import staging directory it created",
  "server/drivers/claude.ts": "removes the per-session mkdtemp MCP config directory",
  "server/drivers/pi.ts": "removes the per-session mkdtemp MCP config directory",
  "server/engine-management.ts": "removes the mkdtemp scratch of an engine install probe",
  "server/fuigo-native-update.ts": "removes the mkdtemp probe home and download directory",
  "server/index.ts": "removes the mkdtemp scratch of a selected-conversation export",
  "server/installation-archive.ts": "removes the mkdtemp write scratch and inspection stage of a backup archive",
  "server/installation-damaged-export.ts": "removes the mkdtemp scratch of a damaged-installation export",
  "server/installation-database-snapshot.ts": "removes the mkdtemp scratch beside the snapshot target",
  "server/installation-recovery-command.ts": "removes the mkdtemp scratch of backup inspect / restore plan commands",
  "server/installation-restore-preparation.ts": "removes the inspected archive directory it extracted when preparation fails",
  "server/installation-restore.ts": "removes an unpublished restore candidate and its inspection directory; never the installation root",
  "server/installation-state-snapshot.ts": "removes the unpublished snapshot stage",
  "server/package-import-transaction.ts": "removes the import transaction directory and empty parents it created",
  "server/provider-routing.ts": "cleanup of the mkdtemp provider home a routing probe created",
  "server/skills.ts": "removes skill directories, legacy links and staging under DATA_DIR/skills that the store owns",
  "server/store.ts": "removes a deleted bot's workspace and skill-state subdirectories under DATA_DIR",
  "server/tts/system-voices.ts": "removes the mkdtemp directory a voice probe created",
};

/** vitest files run under server/testing/setup.ts: HOME is a mkdtemp under
 *  os.tmpdir(), MURAGE_DATA_DIR is deleted before any import, and
 *  installSafeWipeGuard() makes every recursive fs delete refuse the
 *  account's real ~/.murage, any home, the checkout and live leases. */
const VITEST_INCLUDE = [/^server\/.*\.test\.ts$/, /^electron\/.*\.test\.mjs$/, /^src\/.*\.test\.ts$/, /^shared\/.*\.test\.ts$/, /^companion\/.*\.test\.ts$/, /^scripts\/.*\.test\.mjs$/];

const tracked = (): string[] => execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\0").filter(Boolean);

const findDeletes = (file: string): string[] => {
  const hits: string[] = [];
  const text = readFileSync(join(ROOT, file), "utf8");
  const shellLike = /\.(?:sh|yml|yaml|ps1|nsh|nsi|py)$/.test(file);
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#")) return;
    if (NOT_A_DELETE.test(line) && !/\b(?:rmSync|rm|rmdirSync|rmdir|rimraf)\s*\(/.test(line)) return;
    if (JS_DELETE.test(line) || (shellLike && SHELL_DELETE.test(line)) || (!shellLike && /["'`][^"'`]*\brm\s+-[a-zA-Z]*[rR]/.test(line))) {
      hits.push(`${file}:${index + 1}: ${trimmed.slice(0, 140)}`);
    }
  });
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
    for (const file of files.filter(f => f.startsWith("src/e2e/") && f !== "src/e2e/lane-data-dir.ts")) {
      const text = readFileSync(join(ROOT, file), "utf8");
      text.split("\n").forEach((line, index) => {
        if (/process\.env\.MURAGE_E2E_DATA_DIR/.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders).toEqual([]);
    const helper = readFileSync(join(ROOT, "src/e2e/lane-data-dir.ts"), "utf8");
    expect(helper).not.toMatch(/MURAGE_E2E_DATA_DIR\s*(?:\|\||\?\?)/);
    expect(helper).toMatch(/assertSafeToWipe\(/);
  });

  it("every Playwright outputDir is evidence under the lane data dir, the repo's .planning or test-results, or an operator-named evidence dir", () => {
    const bad: string[] = [];
    for (const file of files.filter(f => /^src\/e2e\/.*\.config\.ts$/.test(f))) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const match = /outputDir\s*:\s*([^,}]+)/.exec(text);
      if (!match) { bad.push(`${file}: no outputDir`); continue; }
      const expr = match[1].trim();
      const ok = /^["'`]\.\.\/\.\.\/(?:\.planning|test-results)\//.test(expr)
        || /^out$/.test(expr)
        || /laneEvidenceDir\(/.test(expr)
        || /^process\.env\.MURAGE_(?:E2E_OUTPUT|E2E_EVIDENCE_DIR|WATCH_UI_OUTPUT)\s*(?:\?\?|\|\|)\s*["'`]\.\.\/\.\.\/\.planning\//.test(expr);
      if (!ok) bad.push(`${file}: outputDir ${expr}`);
      if (/^out$/.test(expr)) {
        const decl = /const out\s*=\s*([^;]+);/.exec(text)?.[1] ?? "";
        const declOk = /laneEvidenceDir\(/.test(decl) && !/MURAGE_E2E_DATA_DIR/.test(decl)
          && !/["'`]\.\.\/\.\.\/(?!\.planning\/|test-results\/)/.test(decl);
        if (!declOk) bad.push(`${file}: out = ${decl.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the runtime guard is installed for vitest and for node --test", () => {
    expect(readFileSync(join(ROOT, "server/testing/setup.ts"), "utf8")).toMatch(/^installSafeWipeGuard\(\);/m);
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:electron"]).toContain("--import ./server/testing/safe-wipe-preload.mjs");
    expect(readFileSync(join(ROOT, "server/testing/safe-wipe-preload.mjs"), "utf8")).toMatch(/installSafeWipeGuard\(\)/);
  });
});
