import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { claudeExecSpawnProven } from "./drivers/claude.ts";
import { installMurageExec, writeExecEnvFile } from "./drivers/murage-exec.ts";

it.skipIf(process.platform === "win32").each([false, true])("X3 shape checking at No limits=%s cannot refuse an ordinary command", noLimits => {
  const input = { threadId: `x3-rc-level-${noLimits}`, cli: "fixture", shell: "/bin/bash", map: { PATH: "/usr/bin:/bin" },
    cwd: process.cwd(), envs: [], managedPaths: [], noLimits };
  const proof = claudeExecSpawnProven(input);
  expect(proof.proven).toBe(!noLimits);
  const file = writeExecEnvFile(input.threadId, input.map, input.cwd, input.shell, proof.proven);
  const result = spawnSync(input.shell, [installMurageExec(), "printf x3-ordinary"], {
    env: { PATH: "/usr/bin:/bin", MURAGE_EXEC_ENV_FILE: file }, encoding: "utf8",
  });
  expect(result.status).toBe(noLimits ? 0 : 126);
  expect(result.stdout).toBe(noLimits ? "x3-ordinary" : "");
});

it.each([false, true])("X3 managed proof settings at No limits=%s do not add a refusal", async noLimits => {
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { claudeOverlayEnv } = await import("./drivers/claude.ts");
  const managed = join(process.env.HOME!, "x3-managed.json");
  writeFileSync(managed, JSON.stringify({ env: { MURAGE_EXEC_NONCE: "fixture" } }));
  const overlay = (claudeOverlayEnv as (...args: any[]) => ReturnType<typeof claudeOverlayEnv>)("linux", { kind: "murage-exec", shell: "/bin/bash" },
    { PATH: "/usr/bin:/bin" }, [], [managed], null, noLimits);
  expect("refusal" in overlay).toBe(!noLimits);
});

it.each(["/tmp/murage-mcp-Ab12Cd/mcp.json", "/work/shell-snapshots/fixture.sh", "/tmp/murage-render-" + "a".repeat(16) + "/mcp.json"])("X3 new coverage %s cannot add a No limits card", async path => {
  const { autoVerdict } = await import("./auto-approve.ts");
  const context = { fullAccessOrigin: "owner" as const, ownerStarted: true, stopLine: null, outsideRead: null,
    call: { engine: "claude" as const, toolCall: { name: "Write", input: { file_path: path, content: "fixture" } } } };
  const bot = { id: "x3-coverage", autoApprove: true, fullAccess: true, noLimits: true };
  expect(autoVerdict(bot, "Write", path, context).approve).not.toBeNull();
  expect(autoVerdict({ ...bot, noLimits: false }, "Write", path, context).approve).toBeNull();
});

it.each([false, true])("X3 cwd preparation at No limits=%s cannot intercept the wipe-only policy", async noLimits => {
  const { autoVerdict } = await import("./auto-approve.ts");
  const context = { fullAccessOrigin: "owner" as const, ownerStarted: true, stopLine: null, outsideRead: null,
    threadId: "x3-cwd-fault", commandText: "printf x3-cwd" };
  let reads = 0;
  Object.defineProperty(context, "shellCwdByThread", { get() { reads++; throw new Error("fixture cwd reader fault"); } });
  const bot = { id: "x3-cwd-fault", autoApprove: true, fullAccess: true, noLimits };
  expect(autoVerdict(bot, "Bash", context.commandText, context).approve !== null).toBe(noLimits);
  expect(reads).toBe(noLimits ? 0 : 1);
  if (noLimits) expect(autoVerdict(bot, "Bash", "rm -rf /", { ...context, commandText: "rm -rf /" }).approve).toBeNull();
});

it.skipIf(process.platform === "win32").each([false, true])("X3 custom environment map at No limits=%s keeps the legacy execution path", async noLimits => {
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { claudeOverlayEnv } = await import("./drivers/claude.ts");
  const map = join(process.env.HOME!, "valid-custom-map");
  // This format was accepted before X3: it names the cwd, shell and environment.
  writeFileSync(map, `MURAGE_EXEC_CWD=${process.cwd()}\0MURAGE_EXEC_SHELL=/bin/bash\0PATH=/usr/bin:/bin\0`);
  const overlay = claudeOverlayEnv("linux", { kind: "murage-exec", shell: "/bin/bash" }, { PATH: "/usr/bin:/bin", MURAGE_EXEC_ENV_FILE: map }, [], [], null, noLimits);
  if ("refusal" in overlay) throw new Error(overlay.refusal);
  const result = spawnSync("/bin/bash", [installMurageExec(noLimits), "printf x3-custom-map"], {
    env: { ...overlay.env, MURAGE_EXEC_ENV_FILE: map }, encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(noLimits ? 0 : 126);
  expect(result.stdout).toBe(noLimits ? "x3-custom-map" : "");
});

// Classified only; none of these command strings are executed by this test.
it("X3 wipe-only compatibility keeps a real wipe while treating Write contents as data", async () => {
  const { autoVerdict } = await import("./auto-approve.ts");
  const bot = { autoApprove: true, fullAccess: true, noLimits: true };
  const owner = { fullAccessOrigin: "owner" as const, ownerStarted: true, stopLine: null, outsideRead: null };
  expect(autoVerdict(bot, "Bash", "rm -rf /", { ...owner, commandText: "rm -rf /" }).approve).toBeNull();
  expect(autoVerdict(bot, "Write", "/tmp/murage-mcp-Ab12Cd/mcp.json", { ...owner,
    call: { engine: "claude", toolCall: { name: "Write", input: { file_path: "/tmp/murage-mcp-Ab12Cd/mcp.json", content: "rm -rf /" } } } }).approve).not.toBeNull();
});
