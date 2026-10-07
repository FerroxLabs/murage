// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Upstream #1857, adapted: ambient MURAGE_* runtime keys never reach a test,
// the modules it loads or the children it spawns.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { childEnv, isAmbientMurageKey, stripMurageEnv } from "./murage-env.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;
// What setup.ts itself sets after the scrub, on purpose.
const SET_BY_SETUP = new Set(["MURAGE_ALLOW_DEV_DESKTOP_SECRET", "MURAGE_COMPANION_DIR", "MURAGE_COMPANION_TOKEN", "MURAGE_CONTROL_PORT_OVERRIDE"]);

describe("ambient Murage environment", () => {
  it("runtime keys are ambient; keys that steer the test run are not", () => {
    for (const key of ["MURAGE_DATA_DIR", "MURAGE_HARNESS_URL", "MURAGE_COMMS_TOKEN", "MURAGE_PORT", "MURAGE_BOT_ID", "MURAGE_DEV_DESKTOP_SECRET", "MURAGE_ACP_POOL", "MURAGE_SKIP_PROVIDER_KEY"])
      expect(isAmbientMurageKey(key), key).toBe(true);
    for (const key of ["MURAGE_BACKUP_TEST_AGE_DIR", "MURAGE_E2E_DATA_DIR", "MURAGE_SMOKE_DIST", "MURAGE_KEEP_SMOKE_DIR", "MURAGE_SKIP_REAL_ELECTRON_BROWSER_FIXTURE", "MURAGE_B33_NATIVE_DIR", "MURAGE_QUAL_EVIDENCE_DIR", "MURAGE_GEPA_TEST_PYTHON", "PATH", "HOME"])
      expect(isAmbientMurageKey(key), key).toBe(false);
  });

  it("the vitest setup left no runtime key but its own", () => {
    expect(Object.keys(process.env).filter(key => isAmbientMurageKey(key) && !SET_BY_SETUP.has(key))).toEqual([]);
  });

  it("childEnv strips the ambient keys and keeps what the test sets", () => {
    const env = stripMurageEnv({ MURAGE_DATA_DIR: "/live", MURAGE_BACKUP_TEST_AGE_DIR: "/age", PATH: "/bin" });
    expect(env).toEqual({ MURAGE_BACKUP_TEST_AGE_DIR: "/age", PATH: "/bin" });
    expect(childEnv({ MURAGE_DATA_DIR: "/tmp/x" }).MURAGE_DATA_DIR).toBe("/tmp/x");
  });

  it("node --test files get the same scrub from the preload, and an exported data dir stays guarded", () => {
    const probe = [
      "const fs = await import('node:fs');",
      "const keys = Object.keys(process.env).filter(key => key.startsWith('MURAGE_')).sort();",
      "let refused = false;",
      "try { fs.rmSync('/murage-authz-ambient-probe/data', { recursive: true, force: true }); } catch (error) { refused = error.name === 'SafeWipeRefused' || /refus/i.test(String(error.message)); }",
      "process.stdout.write(JSON.stringify({ keys, refused }));",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--import", join(ROOT, "server/testing/safe-wipe-preload.mjs"), "--input-type=module", "-e", probe], {
      cwd: ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", MURAGE_DATA_DIR: "/murage-authz-ambient-probe/data", MURAGE_HARNESS_URL: "http://127.0.0.1:1", MURAGE_COMMS_TOKEN: "ambient", MURAGE_BACKUP_TEST_AGE_DIR: "/age" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ keys: ["MURAGE_BACKUP_TEST_AGE_DIR", "MURAGE_TEST_ENV_SCRUBBED"], refused: true });
  });

  // A child a test spawns inherits the preload through execArgv; the keys
  // the test set for it are deliberate and must survive (backup-schedule-host
  // hands its worker MURAGE_* settings this way).
  it("a child the test spawned keeps the keys the test gave it", () => {
    const result = spawnSync(process.execPath, ["--import", join(ROOT, "server/testing/safe-wipe-preload.mjs"), "--input-type=module", "-e", "process.stdout.write(process.env.MURAGE_DATA_DIR ?? '')"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", MURAGE_TEST_ENV_SCRUBBED: "1", MURAGE_DATA_DIR: "/tmp/murage-child-data" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("/tmp/murage-child-data");
  });
});
