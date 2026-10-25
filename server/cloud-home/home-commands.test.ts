// SPDX-License-Identifier: AGPL-3.0-or-later
// The home side of self-service (deploy/cloud-home/murage-commands): the real Python module against a modeled control plane
// (home-commands.fixture.py). restic, openssl, age and zstd run for real where the scenario needs them; the reset/undo
// round trip runs once on a plain directory and once on a loopback ext4 volume (root only: a privileged test container).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CloudSessions } from "../cloud-sessions.ts";
import { HomeExecutionGate } from "./b1b-execution.ts";
import { HOME_SERVER_ENV_KEYS, HOME_SERVER_OPTIONAL_ENV_KEYS, homeBootContract, homeServerEnvironment } from "./boot.ts";

const deploy = (name: string) => fileURLToPath(new URL(`../../deploy/cloud-home/${name}`, import.meta.url));
const fixture = fileURLToPath(new URL("./home-commands.fixture.py", import.meta.url));
const contract = fileURLToPath(new URL("../../shared/self-service-contract.json", import.meta.url));
const has = (tool: string) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
const root = process.getuid?.() === 0;
// Release signatures are Ed25519 over raw bytes (openssl pkeyutl -rawin): OpenSSL 3 has it, the LibreSSL that macOS ships as
// /usr/bin/openssl does not. The fixture signs and verifies with the real openssl where both the PATH's and /usr/bin's are OpenSSL 3
// and otherwise models the signature behind the same verify seam (its "immutable" and signer modes are reported in its result).

function scenario(name: string): Record<string, unknown> {
  const result = spawnSync("python3", ["-I", fixture, deploy("murage-commands"), deploy("murage-backup"), deploy("backup-excludes.txt"), name, contract],
    { encoding: "utf8", timeout: 240_000 });
  expect(result.stderr, `${name} stderr`).not.toMatch(/CHECK FAILED|Traceback/u);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").pop()!) as Record<string, unknown>;
}

describe("self-service command runner (home side)", () => {
  it("restart: runs once per command id, acknowledges done, never re-runs a replayed id", () => {
    expect(scenario("restart")).toMatchObject({ ok: true, restart: [["restart", "murage-home.service"], ["is-active", "--quiet", "murage-home.service"]] });
  });
  it("safe mode: one flagged start, failed when the home does not come back, cleared by a normal restart", () => {
    expect(scenario("safe-mode").ok).toBe(true);
  });
  it("refuses unknown commands, unknown fields and shell-shaped values without running anything", () => {
    expect(scenario("refusals").ok).toBe(true);
  });
  it("an interrupted command is reported failed and never re-run; a lost ack is re-sent without re-running", () => {
    expect(scenario("interrupted").ok).toBe(true);
  });
  const linux = process.platform === "linux"; // the start gate is SO_PEERCRED + pidfd (Linux); the home is a Linux role
  it.skipIf(!linux)("update (Lane G r3): installs the signed release into the idle slot, flips `current`, commits only after bounded app health with the inhibit held to the commit, keeps the previous slot sealed, never touches the image-pinned launchers; refuses downgrade, tamper, escape, digest mismatch, launcher list and ABI faults; rolls a dead or unhealthy candidate back to signed bytes", () => {
    expect(scenario("update").ok).toBe(true);
  }, 120_000);
  it.skipIf(!linux)("update: the command names one sequence (the rollout's target or the fleet's promoted one): that release installs, an installed target is done, any other release the channel serves is refused; the updater reports installed sequence, lastResult and Stuck on update-state", () => {
    expect(scenario("update-target").ok).toBe(true);
  });

  it.skipIf(!linux)("update: power lost at every phase leaves the installed slot's bytes untouched, boots run no unverified slot code without a grant, and start-up re-drives to done or failed (T-I5, T-H2b, T-S2)", () => {
    expect(scenario("update-cuts")).toMatchObject({ ok: true, cuts: ["installing", "installed", "flip", "verify", "granted"] });
  }, 120_000);
  it.skipIf(!linux)("update: the journal alone decides; every blocked kind is refused in every phase; a layout the phase does not allow or an unreadable journal is Stuck with the explicit stop and refused by the launcher (T-I1, T-I2a, T-S1, T-I4)", () => {
    expect(scenario("update-phases").ok).toBe(true);
  }, 120_000);
  it.skipIf(!linux)("update: a dead candidate with an unanswering restored release stays pending, is re-driven every loop, and after three counted rollback starts is Stuck: blocking, surfacing its reason, stopping the home, never auto-clearing (T-H2a, Q3)", () => {
    expect(scenario("update-pending").ok).toBe(true);
  }, 120_000);
  it.skipIf(!linux)("update: the start gate grants exactly once per counter write to the home unit's root launcher only; boots and restarts without a grant exit 79 gate_denied; the launcher's decision table holds cell by cell (T-G1, T-G2, T-G4)", () => {
    expect(scenario("gate").ok).toBe(true);
  }, 120_000);
  it.skipIf(!linux)("update: a boot inside flip/verify/rollback reaches the counted verify instead of a false Stuck; six corruption shapes inside the span are Stuck with the stop and no start, rename or grant; the stop precedes every flip back and repeats on resume; an idle home is never touched (T-S2, T-S3, T-W1, T-G5)", () => {
    expect(scenario("transition").ok).toBe(true);
  }, 120_000);
  it.skipIf(!linux)("update: the trust root is read only from its image path and must be intact; the floor is the signed live sequence; a corrupted stored signature makes the rollback Stuck; the idle-slot wipe re-derives its target under the drive lock (T-T1, T-T2, T-T3, T-D1)", () => {
    expect(scenario("trust").ok).toBe(true);
  }, 120_000);
  it.skipIf(!linux)("update: a forged state.json during verify changes nothing the updater decides (T-H4a)", () => {
    expect(scenario("forged").ok).toBe(true);
  });
  it.skipIf(!linux)("murage-home-launch: the seal walk refuses an unsealed file, a writable directory, a foreign owner and an escaping link; its digest is murage-commands'; exec_slot refuses uid 0 and non-slot paths; the supervisor is exec'd through the verified descriptor (T-P6, T-P2)", () => {
    expect(scenario("launcher").ok).toBe(true);
  });
  it("collect_logs: allowed diagnostic events only (free text, short private lines included, become a count), allow-listed units, chunked, sign-in directories never read (Astra SELFSERVICE2 #6)", () => {
    const result = scenario("logs");
    const lines = result.sampleLines as string[];
    expect(lines[0]).toBe("server started on port 8799");
    expect(lines.join("\n")).toContain("line omitted");
    expect(lines.join("\n")).not.toMatch(/diary|4321|prompt/u);
  });
  it.skipIf(!has("age") || !has("zstd"))("export: age-encrypted tar.zst at the contract path, no sign-ins, no secrets, key never in a file; the size limit and disk headroom hold during production; abandoned staging removed (Astra SELFSERVICE2 #7, P2)", () => {
    const names = scenario("export").exported as string[];
    expect(names).toContain("data/home/work/report.md");
    expect(names.some((n) => /\.claude|\.codex|\.grok|\.kimi-code|home\/secrets|Cookies|engine-homes\/[^/]+\/(bots\/[^/]+\/)?signin/u.test(n))).toBe(false);
  });
  it("accepts exactly the control plane's commands (shared contract); the export key is the age identity age itself accepts", () => {
    expect(scenario("contract")).toMatchObject({ ok: true, ...(has("age-keygen") ? { ageChecked: true } : {}) });
  });
  it("never starts a command after its run deadline, and never swaps data after it (Astra SELFSERVICE1 #8)", () => {
    expect(scenario("deadline").ok).toBe(true);
  });
  it("recovers an interrupted reset at start even when the control plane no longer lists it", () => {
    expect(scenario("startup-recovery").ok).toBe(true);
  });
  it("an interrupted data swap rolls back exactly (backup-only names too) at every rename, or finishes from the durable swap record even after staging is gone (Astra SELFSERVICE2 #3)", () => {
    expect(scenario("swap-recovery").ok).toBe(true);
  });
  it("a finished result the control plane did not acknowledge is re-sent on its own, without the command being listed (Astra SELFSERVICE2 #3)", () => {
    expect(scenario("unacked-retry").ok).toBe(true);
  });
  it("reset changes nothing unless writers are confirmed stopped, the pre-reset backup exits 0 with a verified snapshot, and the source nightly is complete (Astra SELFSERVICE2 #1)", () => {
    expect(scenario("reset-safety").ok).toBe(true);
  });
  it("sign-ins under folders the backup lacks are kept, parents recreated, never through a link (Astra SELFSERVICE2 P2)", () => {
    expect(scenario("carry").ok).toBe(true);
  });
  it("the home's devices, revocations and spent pair holds are never rolled back by a reset (Astra SELFSERVICE2 #2)", () => {
    expect(scenario("auth-state").ok).toBe(true);
  });
  it("export upload parses the provisioner's sftp://user@host:23/restic and keeps the port (Astra SELFSERVICE2 #8)", () => {
    expect(scenario("upload").ok).toBe(true);
  });
  it("a sign-in carry that fails after the swap stays pending (never done), blocks data work, and completes later (Astra SELFSERVICE3 #2)", () => {
    expect(scenario("carry-pending").ok).toBe(true);
  });
  it("a reset after a bot has run moves and deletes its immutable workspace placeholders, freezes them again in place, finishes, and recovers idempotently from a crash mid-carry (Astra preaudit cloud-home H1)", () => {
    expect(scenario("placeholders")).toMatchObject({ ok: true, immutable: root ? expect.stringMatching(/real|emulated/u) : "emulated" });
  });
  it("a restored file where a sign-in's folder belongs refuses the reset before anything is swapped (Astra SELFSERVICE3 #2)", () => {
    expect(scenario("carry-blocked").ok).toBe(true);
  });
  it("no start of the home (recovery timer, boot or explicit) passes an unresolved reset; a late reboot mid-reset recovers correctly (Astra SELFSERVICE5 #1, #3c)", () => {
    expect(scenario("inhibit").ok).toBe(true);
  });
  it("the start inhibition is flushed (directory entry included) before writers stop, and terminal records before it is lifted: power cuts that lose unflushed changes never let the home start over an unresolved reset (Astra SELFSERVICE6 #1)", () => {
    expect(scenario("durability")).toMatchObject({ ok: true, durability: ["cut-at-stop", "cut-mid-reset", "cut-after-lift"] });
  });
  it.skipIf(!has("age") || !has("zstd"))("the export run deadline stops production independently of output (Astra SELFSERVICE3 #5)", () => {
    expect(scenario("export-deadline").ok).toBe(true);
  });
  it.skipIf(!has("restic"))("reset then undo round trip with real restic (sign-ins kept locally, snapshot kept 9 days from completion)", () => {
    expect(scenario("reset").resetAcks).toEqual(["done", "done", "failed"]);
  }, 120_000);
  it.skipIf(!root || !has("restic") || !has("losetup"))("reset then undo round trip on a loopback ext4 volume", () => {
    expect(scenario("reset-loop")).toMatchObject({ ok: true, resetAcks: ["done", "done", "failed"] });
  }, 120_000);
});

describe("safe mode in the app", () => {
  it("holds every channel and is off by default", () => {
    const db = new DatabaseSync(":memory:");
    try {
      new CloudSessions(db);
      expect(new HomeExecutionGate(db, () => true).channelsOpen("telegram")).toBe(true);
      const safe = new HomeExecutionGate(db, () => true, true);
      expect(safe.safeMode).toBe(true);
      expect(safe.open()).toBe(true);
      for (const channel of ["telegram", "slack", "discord"] as const) expect(safe.channelsOpen(channel)).toBe(false);
    } finally { db.close(); }
  });
  it("reaches the server only through the supervisor's allow-listed environment", () => {
    const contract = homeBootContract({ MURAGE_CLOUD_ROLE: "home", MURAGE_CLOUD_MACHINE_ID: "fixture-home", MURAGE_CLOUD_ADMIN_URL: "https://admin.murage.test",
      MURAGE_PUBLIC_ORIGIN: "https://home.murage.test", MURAGE_CLOUD_BOOTSTRAP_SECRET: "b".repeat(32), MURAGE_SITE_ORIGIN: "https://murage.test" })!;
    expect(homeServerEnvironment(contract, "UTC")).not.toHaveProperty("MURAGE_SAFE_MODE");
    const env = homeServerEnvironment(contract, "UTC", "8800", true);
    expect(env.MURAGE_SAFE_MODE).toBe("1");
    expect(Object.keys(env).sort()).toEqual([...HOME_SERVER_ENV_KEYS, ...HOME_SERVER_OPTIONAL_ENV_KEYS].sort());
  });
  it("routines, user add-ons and the start script honour it; the flag is consumed at start", () => {
    const index = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    expect(index).toContain('process.env.MURAGE_SAFE_MODE === "1"');
    expect(index).toMatch(/automaticPaused: \(\) => [^\n]*homeExecutionGate\?\.safeMode === true/u);
    expect(index).toMatch(/ownServersAllowedFor\(bot\) && homeExecutionGate\?\.safeMode !== true/u);
    const start = readFileSync(deploy("start-home.sh"), "utf8");
    expect(start.indexOf("rm -f /run/murage-safe-mode")).toBeLessThan(start.indexOf("murage-enroll"));
    expect(start).toContain("export MURAGE_SAFE_MODE=1");
    // The flag reaches node only through the launcher's environment, built from scratch (LANE-G r3 sec. 7).
    const launcher = readFileSync(deploy("murage-home-launch.py"), "utf8");
    expect(launcher).toContain('safe_mode = os.environ.get("MURAGE_SAFE_MODE") == "1"');
    expect(launcher).toContain('env["MURAGE_SAFE_MODE"] = "1"');
  });
  it("the runner unit outlives the home unit it restarts", () => {
    const unit = readFileSync(deploy("murage-commands.service"), "utf8");
    expect(unit).not.toMatch(/PartOf=|BindsTo=/u);
    const image = readFileSync(deploy("build-image.sh"), "utf8");
    expect(image).toContain("systemctl enable murage-commands.service");
    expect(image).toContain("install -o root -g root -m 0755 deploy/cloud-home/murage-commands /usr/local/libexec/murage-commands");
  });
});
